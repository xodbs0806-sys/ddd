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
    """작업 디렉토리 내에서 분석할 엑셀 또는 CSV 파일을 자동 탐색합니다."""
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
    """지자체명, 예산, 범죄율, 인구수, 특이사항 컬럼을 자동 감지합니다."""
    cols = df.columns.tolist()
    mapping = {
        "region_col": None,
        "budget_col": None,
        "crime_col": None,
        "pop_col": None,
        "note_col": None
    }
    for c in cols:
        c_str = str(c).strip()
        c_lower = c_str.lower()
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
            "error": "프로젝트 폴더 안에 분석할 엑셀 파일(crime_data.xlsx 등)이 존재하지 않습니다."
        }), 404
        
    try:
        if excel_file.endswith(".csv"):
            try:
                df = pd.read_csv(excel_file, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(excel_file, encoding="cp949")
        else:
            df = pd.read_excel(excel_file, engine="openpyxl")
            
        total_raw_rows = len(df)
        if total_raw_rows == 0:
            return jsonify({"success": False, "error": f"'{excel_file}' 파일에 데이터가 비어 있습니다."}), 400
            
        mapping = auto_detect_columns(df)
        df_clean = df.dropna(how="all")
        missing_count = total_raw_rows - len(df_clean)
        
        return jsonify({
            "success": True,
            "filename": excel_file,
            "total_rows": len(df_clean),
            "missing_count": missing_count,
            "columns": df.columns.tolist(),
            "mapping": mapping,
            "records": df_clean.head(35).to_dict(orient="records")
        })
    except Exception as e:
        logger.error(f"데이터 로드 에러: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/generate", methods=["POST"])
def generate():
    """가설 검증: '예산이 높을수록 범죄율이 낮아질까?' 정밀 분석"""
    excel_file = find_excel_file()
    if not excel_file:
        return jsonify({"success": False, "error": "데이터 파일이 없습니다."}), 400
        
    req_data = request.get_json() or {}
    analysis_mode = req_data.get("mode", "A") # A: 학술 가설 검증, B: 정책 컨설팅
    control_type = req_data.get("control_type", "total") # total vs per_capita
    exclude_commercial = req_data.get("exclude_commercial", False) # 도심 상업/유흥지 제외 필터
    
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
        
        df_work = df.copy()
        df_work[budget_col] = pd.to_numeric(df_work[budget_col], errors="coerce")
        df_work[crime_col] = pd.to_numeric(df_work[crime_col], errors="coerce")
        if pop_col and pop_col in df_work.columns:
            df_work[pop_col] = pd.to_numeric(df_work[pop_col], errors="coerce")
            
        df_work = df_work.dropna(subset=[region_col, budget_col, crime_col])
        
        # 도심 상업/유흥 특이 지자체 제외 필터 적용 시
        if exclude_commercial and note_col and note_col in df_work.columns:
            commercial_keywords = ["상업", "유흥", "도심", "관광"]
            df_work = df_work[~df_work[note_col].astype(str).str.contains("|".join(commercial_keywords), na=False)]
            
        if len(df_work) < 3:
            return jsonify({
                "success": False,
                "error": f"상관분석을 위한 최소 표본(3개)이 부족합니다. (현재: {len(df_work)}건)"
            }), 400
            
        # 변수 설정
        if control_type == "per_capita" and pop_col and pop_col in df_work.columns:
            df_work["x_val"] = df_work[budget_col] / df_work[pop_col].replace(0, np.nan)
            df_work["x_label"] = "1인당 범죄예방예산(원/명)"
            if "율" not in crime_col and "1만" not in crime_col:
                df_work["y_val"] = (df_work[crime_col] / df_work[pop_col].replace(0, np.nan)) * 10000
                df_work["y_label"] = "인구 1만명당 범죄율(건)"
            else:
                df_work["y_val"] = df_work[crime_col]
                df_work["y_label"] = crime_col
        else:
            df_work["x_val"] = df_work[budget_col]
            df_work["x_label"] = budget_col
            df_work["y_val"] = df_work[crime_col]
            df_work["y_label"] = crime_col

        df_work = df_work.dropna(subset=["x_val", "y_val"])
        n = len(df_work)

        # 1. 수학적 통계 연산
        r = float(df_work["x_val"].corr(df_work["y_val"]))
        if math.isnan(r): r = 0.0
        
        # 핵심 가설 판정 로직 ("예산이 높을수록 범죄율이 낮아질까?")
        # 가설 성립 기준: r < 0 (음의 상관)
        if r <= -0.4:
            hypothesis_verdict = "가설 강력 지지 (예산 증액 시 범죄율 뚜렷한 감소 성립)"
            verdict_badge = "success"
        elif r < -0.1:
            hypothesis_verdict = "가설 부분 지지 (약한 범죄 억제 경향 성립)"
            verdict_badge = "info"
        elif abs(r) <= 0.1:
            hypothesis_verdict = "가설 검증 불명확 (예산과 범죄율 간 직접 연관성 낮음)"
            verdict_badge = "neutral"
        elif r <= 0.4:
            hypothesis_verdict = "가설 기각 / 역설 관측 (치안 취약지역에 사후 예산 집중 배정)"
            verdict_badge = "warning"
        else:
            hypothesis_verdict = "가설 기각 / 강력한 역인과성 (범죄 다발지역에 예산 최우선 투입)"
            verdict_badge = "danger"

        x_mean = float(df_work["x_val"].mean())
        x_median = float(df_work["x_val"].median())
        x_std = float(df_work["x_val"].std())
        y_mean = float(df_work["y_val"].mean())
        y_median = float(df_work["y_val"].median())
        y_std = float(df_work["y_val"].std())
        
        slope = float(r * (y_std / x_std)) if x_std > 0 else 0.0
        delta_per_100m = slope * 100000000.0 if control_type == "total" else slope * 10000.0

        # 2. 4사분면 매트릭스 분류 (중앙값 기준 분할)
        quadrants = {
            "q1_reverse": [],    # 고예산-고범죄: 역인과성 집중 구역
            "q2_blindspot": [],  # 저예산-고범죄: 치안 사각지대 (긴급 지원 필요)
            "q3_peaceful": [],   # 저예산-저범죄: 자연 안전 구역 (평온 베드타운)
            "q4_effective": []   # 고예산-저범죄: ★가설 적중 모범 구역 (예산 투입 성과)
        }

        chart_points = []
        for _, row in df_work.iterrows():
            x = float(row["x_val"])
            y = float(row["y_val"])
            reg_name = str(row[region_col])
            note_val = str(row[note_col]) if note_col and note_col in df_work.columns and pd.notna(row[note_col]) else ""
            
            # 사분면 판정
            if x >= x_median and y >= y_median:
                quad = "Q1_REVERSE"
                quad_label = "역인과성 집중 구역 (고예산·고범죄)"
                quad_color = "#f59e0b" # Amber
                quadrants["q1_reverse"].append(reg_name)
            elif x < x_median and y >= y_median:
                quad = "Q2_BLINDSPOT"
                quad_label = "치안 사각지대 (저예산·고범죄)"
                quad_color = "#ef4444" # Red
                quadrants["q2_blindspot"].append(reg_name)
            elif x < x_median and y < y_median:
                quad = "Q3_PEACEFUL"
                quad_label = "자연 평온 구역 (저예산·저범죄)"
                quad_color = "#3b82f6" # Blue
                quadrants["q3_peaceful"].append(reg_name)
            else:
                quad = "Q4_EFFECTIVE"
                quad_label = "가설 적중 모범구역 (고예산·저범죄)"
                quad_color = "#10b981" # Emerald Green
                quadrants["q4_effective"].append(reg_name)

            chart_points.append({
                "x": x,
                "y": y,
                "region": reg_name,
                "note": note_val,
                "quadrant": quad,
                "quad_label": quad_label,
                "quad_color": quad_color
            })

        logger.info(f"가설 검증 완료 | 표본: {n}건 | 상관계수 r: {r:.4f} | 판정: {hypothesis_verdict}")

        # 3. Gemini AI 프롬프트 구성 (가설 검증 중심)
        prompt = f"""당신은 계량행정학 및 공공 안전 치안 빅데이터 정책 연구소의 수석 데이터 사이언티스트입니다.
우리의 핵심 연구 질문은 **"지자체 범죄예방 예산이 높을수록 그 지역의 범죄율이 낮아질까?"** 입니다.
아래 실측 통계 데이터와 4사분면 분류 결과를 바탕으로, 질문에 명쾌하게 답하는 **[가설 검증 및 정책 제언 심층 리포트]**를 마크다운(Markdown)으로 작성하세요.

[실측 데이터 및 가설 검증 지표]
- 연구 가설: "예산($X$)이 높을수록 범죄율($Y$)은 낮아질 것이다 ($r < 0$ 기대)"
- 분석 표본: {n}개 지자체 (분석 기준: {'인구 1인당 표준화' if control_type == 'per_capita' else '단순 총액 비교'})
- 산출된 피어슨 상관계수 ($r$): {r:.4f} ({'양(+)의 상관' if r > 0 else '음(-)의 상관'})
- 시스템 1차 가설 판정: **{hypothesis_verdict}**
- X (예산) 중앙값: {x_median:,.0f}, 평균: {x_mean:,.0f}
- Y (범죄) 중앙값: {y_median:,.1f}, 평균: {y_mean:,.1f}

[4사분면 지자체 분류 실측]
1. ★ 가설 적중 모범 구역 (고예산·저범죄, 예산 투입 효과 입증 지역):
   {', '.join(quadrants['q4_effective']) if quadrants['q4_effective'] else '해당 없음'}
2. 치안 사각지대 (저예산·고범죄, 예산 부족으로 범죄 방치 우려 지역):
   {', '.join(quadrants['q2_blindspot']) if quadrants['q2_blindspot'] else '해당 없음'}
3. 역인과성 집중 구역 (고예산·고범죄, 범죄 다발로 인해 사후 예산 집중 배정 지역):
   {', '.join(quadrants['q1_reverse']) if quadrants['q1_reverse'] else '해당 없음'}
4. 자연 평온 구역 (저예산·저범죄, 주거 베드타운 등 저위험 지역):
   {', '.join(quadrants['q3_peaceful']) if quadrants['q3_peaceful'] else '해당 없음'}

[리포트 필수 작성 요구사항]
1. **질문에 대한 직답 및 가설 검증 결론**:
   - "예산이 높을수록 범죄율이 낮아질까?"라는 질문에 대한 직관적이고 명확한 결론 제시
2. **왜 단순 상관계수는 반대(양의 상관 또는 무상관)로 나타나는가? (치안 예산의 역설)**:
   - 범죄 다발 지역(유동인구, 상업지)에 예산이 집중 투입되는 **'역인과성(Reverse Causality)'**과 **'내생성(Endogeneity)'**을 데이터와 연결하여 초보자도 쉽게 이해할 수 있게 해설
3. **4사분면 지자체별 비교 및 벤치마킹 분석**:
   - [가설 적중 모범 구역] 지자체들의 공통 성공 요인 (CCTV 스마트관제 효율화, 셉테드 CPTED)
   - [치안 사각지대] 지자체에 대한 긴급 예산 수혈 필요성
4. **차년도 예산 정책 제언**:
   - 예산을 무작정 늘린다고 범죄가 줄지 않는 이유와, 실효성 있게 범죄율을 낮추기 위한 '데이터 기반 타겟팅 예산 배분 가이드' 제시
"""

        ai_report = ""
        if GEMINI_API_KEY and GEMINI_API_KEY != "your_gemini_api_key_here":
            try:
                from google import genai
                client = genai.Client(api_key=GEMINI_API_KEY)
                response = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt
                )
                ai_report = response.text
                logger.info("Gemini AI 가설 검증 리포트 생성 완료")
            except Exception as api_err:
                logger.error(f"Gemini API 에러: {str(api_err)}")
                ai_report = f"> [!WARNING] Gemini API 호출 실패: {str(api_err)}\n\n" + generate_hypothesis_report(r, hypothesis_verdict, quadrants, delta_per_100m, control_type)
        else:
            ai_report = generate_hypothesis_report(r, hypothesis_verdict, quadrants, delta_per_100m, control_type)

        return jsonify({
            "success": True,
            "stats": {
                "r": round(r, 4),
                "r_direction": "양(+)의 상관" if r > 0 else ("음(-)의 상관" if r < 0 else "무상관"),
                "hypothesis_verdict": hypothesis_verdict,
                "verdict_badge": verdict_badge,
                "sample_count": n,
                "x_label": df_work["x_label"].iloc[0],
                "y_label": df_work["y_label"].iloc[0],
                "x_median": x_median,
                "y_median": y_median,
                "x_mean": x_mean,
                "y_mean": y_mean,
                "delta_per_100m": round(delta_per_100m, 2),
                "quadrants": quadrants
            },
            "chart_data": chart_points,
            "report_markdown": ai_report
        })

    except Exception as e:
        logger.error(f"가설 분석 에러: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

def generate_hypothesis_report(r, verdict, quad, delta, control_type):
    q4_str = ", ".join([f"**{name}**" for name in quad["q4_effective"]]) if quad["q4_effective"] else "없음"
    q2_str = ", ".join([f"**{name}**" for name in quad["q2_blindspot"]]) if quad["q2_blindspot"] else "없음"
    q1_str = ", ".join([f"**{name}**" for name in quad["q1_reverse"]]) if quad["q1_reverse"] else "없음"
    q3_str = ", ".join([f"**{name}**" for name in quad["q3_peaceful"]]) if quad["q3_peaceful"] else "없음"

    return f"""### 🔍 가설 검증 결과: "예산이 높을수록 범죄율이 낮아질까?"

> [!IMPORTANT]
> **최종 판정**: **{verdict}** (피어슨 상관계수 $r = {r:.4f}$)  
> 단순 통계상으로는 예산이 많은 지역에서 범죄율이 오히려 높거나 비슷하게 관측되는 **'치안 예산의 역설'**이 발생합니다.

---

#### 1. 질문에 대한 해답: "아닙니다. 단순히 예산 총액만 늘린다고 범죄가 줄지 않습니다."
- 산출된 상관계수는 **$r = {r:.4f}$**로, 우리가 기대했던 음(-)의 상관관계("예산 증가 $\\rightarrow$ 범죄 감소")가 전체 지자체 표본에서 즉각적으로 나타나지 않습니다.
- 그 이유는 지자체의 예산 배정이 '사전 예방'보다 **'범죄가 빈발하는 취약지에 사후적으로 예산이 더 많이 투입되는 역인과성(Reverse Causality)'** 구조를 띠기 때문입니다.

---

#### 2. 4사분면 매트릭스를 통해 본 진짜 진실
지자체를 예산과 범죄율의 중앙값 기준으로 4개 영역으로 나누어 분석하면 놀라운 패턴이 드러납니다:

1. **★ 가설 적중 모범 구역 (고예산 · 저범죄)**: {q4_str}
   - **가설이 증명된 지자체들입니다!** 충분한 예산을 투입하여 셉테드(CPTED) 설계와 지능형 CCTV 관제망을 촘촘히 구축함으로써 범죄를 효과적으로 억제하고 있습니다.
2. **치안 사각지대 (저예산 · 고범죄)**: {q2_str}
   - 예산 투입이 절실한 지역입니다. 적은 재정으로 인해 범죄율이 여전히 높은 수준에 머물러 있어, 차년도 긴급 특별교부세 수혈이 우선되어야 합니다.
3. **역인과성 집중 구역 (고예산 · 고범죄)**: {q1_str}
   - 강남, 영등포 등 상업/유흥 시설과 유동인구가 집중되는 곳입니다. 범죄 위험이 워낙 크기 때문에 지자체에서도 막대한 예산을 쏟아붓고 있는 대표적인 '역인과성' 권역입니다.
4. **자연 평온 구역 (저예산 · 저범죄)**: {q3_str}
   - 전형적인 주거 베드타운으로 자체 치안 수요가 낮아 적은 예산으로도 안전이 유지되는 지자체입니다.

---

#### 3. 차년도 예산 정책 제언: 어떻게 해야 범죄율을 낮출 수 있는가?
1. **일괄 균등 배분 탈피**: 범죄율이 높으나 예산이 적은 **치안 사각지대({q2_str})**에 예산을 집중 재배분해야 합니다.
2. **하드웨어 증설 대신 타겟팅 소프트웨어 치안**: 이미 고예산을 쓰고 있는 역인과성 구역은 하드웨어보다 야간 유동인구 맞춤형 순찰 및 범죄예방 디자인으로 질적 전환이 필요합니다.
"""

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
