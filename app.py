import os
import glob
import math
import logging
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import pandas as pd
import numpy as np

# 1. 환경변수 로드
load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

# 로깅 설정 (보안: API 키 원본 출력 차단)
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
)
logger = logging.getLogger("CrimeBudgetAnalyzer")

app = Flask(__name__)

def find_excel_file():
    """분석할 엑셀 또는 CSV 파일을 자동 탐색합니다."""
    if os.path.exists("crime_data.xlsx"):
        return "crime_data.xlsx"
    excel_files = glob.glob("*.xlsx") + glob.glob("*.xls")
    if excel_files:
        return excel_files[0]
    csv_files = glob.glob("*.csv")
    if csv_files:
        return csv_files[0]
    return None

def auto_detect_columns(df):
    """동네명, 시도, 예산, 범죄 건수, 주민 수 컬럼을 자동 감지합니다."""
    cols = df.columns.tolist()
    mapping = {
        "sido_col": None,
        "region_col": None,
        "budget_col": None,
        "crime_col": None,
        "pop_col": None,
        "note_col": None,
        "lat_col": None,
        "lng_col": None
    }
    for c in cols:
        c_str = str(c).strip()
        c_lower = c_str.lower()
        if not mapping["sido_col"] and any(k in c_lower for k in ["시도", "광역", "sido"]):
            mapping["sido_col"] = c_str
        if not mapping["region_col"] and any(k in c_lower for k in ["지자체", "지역", "시군구", "자치구", "구명", "지역명", "city", "region"]):
            mapping["region_col"] = c_str
        if not mapping["budget_col"] and any(k in c_lower for k in ["예산", "세입", "세출", "금액", "budget", "안전예산"]):
            mapping["budget_col"] = c_str
        if not mapping["crime_col"] and any(k in c_lower for k in ["범죄율", "범죄발생", "발생건수", "1만명당", "crime"]):
            mapping["crime_col"] = c_str
        if not mapping["pop_col"] and any(k in c_lower for k in ["인구", "인구수", "주민", "pop"]):
            mapping["pop_col"] = c_str
        if not mapping["note_col"] and any(k in c_lower for k in ["특이", "비고", "메모", "note", "desc"]):
            mapping["note_col"] = c_str
        if not mapping["lat_col"] and any(k in c_lower for k in ["위도", "lat", "latitude"]):
            mapping["lat_col"] = c_str
        if not mapping["lng_col"] and any(k in c_lower for k in ["경도", "lng", "lon", "longitude"]):
            mapping["lng_col"] = c_str
            
    if not mapping["region_col"] and len(cols) > 0: mapping["region_col"] = cols[0]
    if not mapping["budget_col"] and len(cols) > 1: mapping["budget_col"] = cols[1]
    if not mapping["crime_col"] and len(cols) > 2: mapping["crime_col"] = cols[2]
    return mapping

@app.route("/")
def index():
    excel_file = find_excel_file()
    file_status = {
        "found": excel_file is not None,
        "filename": excel_file if excel_file else "파일 없음"
    }
    return render_template("index.html", file_status=file_status)

@app.route("/load-data", methods=["GET"])
def load_data():
    excel_file = find_excel_file()
    if not excel_file:
        return jsonify({
            "success": False,
            "error": "폴더 안에 분석할 데이터 파일(crime_data.xlsx 등)이 없습니다."
        }), 404
        
    try:
        if excel_file.endswith(".csv"):
            try: df = pd.read_csv(excel_file, encoding="utf-8")
            except UnicodeDecodeError: df = pd.read_csv(excel_file, encoding="cp949")
        else:
            df = pd.read_excel(excel_file, engine="openpyxl")
            
        total_raw_rows = len(df)
        if total_raw_rows == 0:
            return jsonify({"success": False, "error": f"'{excel_file}' 파일에 데이터가 비어 있습니다."}), 400
            
        mapping = auto_detect_columns(df)
        df_clean = df.dropna(how="all")
        missing_count = total_raw_rows - len(df_clean)
        
        sido_list = []
        if mapping["sido_col"] and mapping["sido_col"] in df_clean.columns:
            sido_list = sorted([str(s) for s in df_clean[mapping["sido_col"]].dropna().unique()])
        elif mapping["region_col"]:
            sidos = set()
            for r in df_clean[mapping["region_col"]].dropna():
                r_str = str(r).strip()
                for s in ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주']:
                    if r_str.startswith(s):
                        sidos.add(s)
            sido_list = sorted(list(sidos))
        
        return jsonify({
            "success": True,
            "filename": excel_file,
            "total_rows": len(df_clean),
            "missing_count": missing_count,
            "columns": df.columns.tolist(),
            "mapping": mapping,
            "sido_list": sido_list,
            "records": df_clean.to_dict(orient="records")
        })
    except Exception as e:
        logger.error(f"데이터 로드 에러: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/generate", methods=["POST"])
def generate():
    """전국 및 시도별 가설 실증 & 지도 데이터 생성"""
    excel_file = find_excel_file()
    if not excel_file:
        return jsonify({"success": False, "error": "데이터 파일이 없습니다."}), 400
        
    req_data = request.get_json() or {}
    analysis_mode = req_data.get("mode", "A")
    control_type = req_data.get("control_type", "total")
    exclude_commercial = req_data.get("exclude_commercial", False)
    selected_sido = req_data.get("selected_sido", "ALL")
    
    try:
        if excel_file.endswith(".csv"):
            try: df = pd.read_csv(excel_file, encoding="utf-8")
            except UnicodeDecodeError: df = pd.read_csv(excel_file, encoding="cp949")
        else:
            df = pd.read_excel(excel_file, engine="openpyxl")
            
        mapping = auto_detect_columns(df)
        region_col = req_data.get("region_col") or mapping["region_col"]
        budget_col = req_data.get("budget_col") or mapping["budget_col"]
        crime_col = req_data.get("crime_col") or mapping["crime_col"]
        pop_col = req_data.get("pop_col") or mapping["pop_col"]
        note_col = req_data.get("note_col") or mapping["note_col"]
        sido_col = mapping["sido_col"]
        lat_col = mapping["lat_col"]
        lng_col = mapping["lng_col"]
        
        df_work = df.copy()
        
        if selected_sido and selected_sido != "ALL":
            if sido_col and sido_col in df_work.columns:
                df_work = df_work[df_work[sido_col].astype(str) == selected_sido]
            else:
                df_work = df_work[df_work[region_col].astype(str).str.startswith(selected_sido)]
                
        df_work[budget_col] = pd.to_numeric(df_work[budget_col], errors="coerce")
        df_work[crime_col] = pd.to_numeric(df_work[crime_col], errors="coerce")
        if pop_col and pop_col in df_work.columns:
            df_work[pop_col] = pd.to_numeric(df_work[pop_col], errors="coerce")
            
        df_work = df_work.dropna(subset=[region_col, budget_col, crime_col])
        
        if exclude_commercial and note_col and note_col in df_work.columns:
            commercial_keywords = ["상업", "유흥", "도심", "관광", "번화가"]
            df_work = df_work[~df_work[note_col].astype(str).str.contains("|".join(commercial_keywords), na=False)]
            
        if len(df_work) < 3:
            return jsonify({
                "success": False,
                "error": f"선택한 조건의 동네 데이터가 부족합니다 (최소 3개 필요, 현재 {len(df_work)}개). 지역 선택을 '전국 전체'로 변경해 보세요."
            }), 400
            
        if control_type == "per_capita" and pop_col and pop_col in df_work.columns:
            df_work["x_val"] = df_work[budget_col] / df_work[pop_col].replace(0, np.nan)
            df_work["x_label"] = "주민 1인당 방범 예산 (원)"
            if "율" not in crime_col and "1만" not in crime_col:
                df_work["y_val"] = (df_work[crime_col] / df_work[pop_col].replace(0, np.nan)) * 10000
                df_work["y_label"] = "주민 1만 명당 범죄 발생 (건)"
            else:
                df_work["y_val"] = df_work[crime_col]
                df_work["y_label"] = crime_col
        else:
            df_work["x_val"] = df_work[budget_col]
            df_work["x_label"] = "동네 총 방범 예산"
            df_work["y_val"] = df_work[crime_col]
            df_work["y_label"] = "동네 총 범죄 발생 건수"

        df_work = df_work.dropna(subset=["x_val", "y_val"])
        n = len(df_work)

        r = float(df_work["x_val"].corr(df_work["y_val"]))
        if math.isnan(r): r = 0.0
        
        target_region_label = "전국" if selected_sido == "ALL" else f"'{selected_sido}' 지역"
        
        if r <= -0.4:
            hypothesis_verdict = f"⭕ {target_region_label}: 예산을 많이 쓴 동네일수록 범죄가 눈에 띄게 적습니다!"
            verdict_badge = "success"
        elif r < -0.1:
            hypothesis_verdict = f"△ {target_region_label}: 예산을 더 쓴 동네가 범죄가 조금 적은 편입니다."
            verdict_badge = "info"
        elif abs(r) <= 0.1:
            hypothesis_verdict = f"❓ {target_region_label}: 예산 액수와 범죄 건수는 거의 따로 움직입니다."
            verdict_badge = "neutral"
        elif r <= 0.4:
            hypothesis_verdict = f"❌ {target_region_label}: 오히려 돈을 많이 쓴 동네에서 범죄가 더 많이 잡힙니다."
            verdict_badge = "warning"
        else:
            hypothesis_verdict = f"❌ {target_region_label}: 범죄가 심각한 번화가에 구청 예산이 가장 많이 쏟아붓고 있습니다."
            verdict_badge = "danger"

        x_mean = float(df_work["x_val"].mean())
        x_median = float(df_work["x_val"].median())
        x_std = float(df_work["x_val"].std())
        y_mean = float(df_work["y_val"].mean())
        y_median = float(df_work["y_val"].median())
        y_std = float(df_work["y_val"].std())
        
        slope = float(r * (y_std / x_std)) if x_std > 0 else 0.0
        delta_per_100m = slope * 100000000.0 if control_type == "total" else slope * 10000.0

        quadrants = {
            "q1_reverse": [],
            "q2_blindspot": [],
            "q3_peaceful": [],
            "q4_effective": []
        }

        chart_points = []
        for _, row in df_work.iterrows():
            x = float(row["x_val"])
            y = float(row["y_val"])
            reg_name = str(row[region_col])
            note_val = str(row[note_col]) if note_col and note_col in df_work.columns and pd.notna(row[note_col]) else ""
            
            # 위경도 추출 (없으면 기본값)
            lat = float(row[lat_col]) if lat_col and lat_col in df_work.columns and pd.notna(row[lat_col]) else 36.5
            lng = float(row[lng_col]) if lng_col and lng_col in df_work.columns and pd.notna(row[lng_col]) else 127.5
            
            if x >= x_median and y >= y_median:
                quad = "Q1_REVERSE"
                quad_label = "초집중 번화가 (예산 많음 · 범죄 많음)"
                quad_short = "번화가"
                quad_color = "#f59e0b"
                quadrants["q1_reverse"].append(reg_name)
            elif x < x_median and y >= y_median:
                quad = "Q2_BLINDSPOT"
                quad_label = "예산 지원 시급 (예산 적음 · 범죄 많음)"
                quad_short = "예산부족"
                quad_color = "#ef4444"
                quadrants["q2_blindspot"].append(reg_name)
            elif x < x_median and y < y_median:
                quad = "Q3_PEACEFUL"
                quad_label = "자연 평온 동네 (예산 적음 · 범죄 적음)"
                quad_short = "평온동네"
                quad_color = "#3b82f6"
                quadrants["q3_peaceful"].append(reg_name)
            else:
                quad = "Q4_EFFECTIVE"
                quad_label = "1등 안심 동네 (예산 듬뿍 · 범죄는 뚝!)"
                quad_short = "1등안심"
                quad_color = "#10b981"
                quadrants["q4_effective"].append(reg_name)

            chart_points.append({
                "x": x,
                "y": y,
                "region": reg_name,
                "note": note_val,
                "lat": lat,
                "lng": lng,
                "quadrant": quad,
                "quad_label": quad_label,
                "quad_short": quad_short,
                "quad_color": quad_color
            })

        logger.info(f"분석 완료 | 대상: {target_region_label} (표본: {n}개 동네) | 상관도: {r:.4f}")

        # 글이 너무 길지 않도록 3~4줄 핵심 요약 중심 리포트 생성
        ai_report = generate_concise_report(r, hypothesis_verdict, quadrants, target_region_label)

        return jsonify({
            "success": True,
            "target_region_label": target_region_label,
            "selected_sido": selected_sido,
            "stats": {
                "r": round(r, 4),
                "hypothesis_verdict": hypothesis_verdict,
                "verdict_badge": verdict_badge,
                "sample_count": n,
                "x_label": df_work["x_label"].iloc[0],
                "y_label": df_work["y_label"].iloc[0],
                "x_median": x_median,
                "y_median": y_median,
                "x_mean": x_mean,
                "y_mean": y_mean,
                "delta_per_100m": round(delta_per_100m, 1),
                "quadrants": quadrants
            },
            "chart_data": chart_points,
            "report_markdown": ai_report
        })

    except Exception as e:
        logger.error(f"분석 중 오류: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

def generate_concise_report(r, verdict, quad, region_label):
    q4_str = ", ".join([f"**{name}**" for name in quad["q4_effective"][:5]]) if quad["q4_effective"] else "해당 없음"
    q2_str = ", ".join([f"**{name}**" for name in quad["q2_blindspot"][:5]]) if quad["q2_blindspot"] else "해당 없음"
    q1_str = ", ".join([f"**{name}**" for name in quad["q1_reverse"][:5]]) if quad["q1_reverse"] else "해당 없음"
    q3_str = ", ".join([f"**{name}**" for name in quad["q3_peaceful"][:5]]) if quad["q3_peaceful"] else "해당 없음"

    return f"""### 💡 [{region_label}] 핵심 3줄 요약

> [!IMPORTANT]
> **결론**: **{verdict}**  
> *"불이 많이 나는 곳에 소방관을 더 많이 보내듯, 사건이 잦은 번화가에 구청과 경찰이 예산을 뒤늦게 집중 투입하고 있습니다."*

* 🟢 **1등 안심 동네 (예산 듬뿍, 범죄 뚝!)**: {q4_str}
* 🔴 **예산 지원 시급 동네 (범죄 많은데 예산 부족)**: {q2_str}
* 🟡 **초집중 번화가 동네 (사건도 많고 예산도 많음)**: {q1_str}
* 🔵 **자연 평온 동네 (적은 돈으로도 평온함)**: {q3_str}
"""

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
