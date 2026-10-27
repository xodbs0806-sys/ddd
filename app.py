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

# 로깅 설정 (보안: API 키 원본 출력 엄격 차단)
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
)
logger = logging.getLogger("CrimeBudgetAnalyzer")

app = Flask(__name__)

def find_excel_file():
    """작업 디렉토리 내에서 분석할 엑셀 또는 CSV 파일을 자동 탐색합니다."""
    # 1순위: crime_data.xlsx
    if os.path.exists("crime_data.xlsx"):
        return "crime_data.xlsx"
    
    # 2순위: 기타 .xlsx 또는 .xls 파일
    excel_files = glob.glob("*.xlsx") + glob.glob("*.xls")
    if excel_files:
        return excel_files[0]
        
    # 3순위: .csv 파일
    csv_files = glob.glob("*.csv")
    if csv_files:
        return csv_files[0]
        
    return None

def auto_detect_columns(df):
    """데이터프레임의 컬럼명을 분석하여 지자체, 예산, 범죄율, 인구수 컬럼을 자동으로 매핑합니다."""
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
        
        # 지자체명 열 감지
        if not mapping["region_col"] and any(k in c_lower for k in ["지자체", "지역", "시군구", "자치구", "구명", "지역명", "city", "region"]):
            mapping["region_col"] = c_str
        # 예산 열 감지
        if not mapping["budget_col"] and any(k in c_lower for k in ["예산", "세입", "세출", "금액", "budget", "안전예산"]):
            mapping["budget_col"] = c_str
        # 범죄율 / 발생건수 열 감지
        if not mapping["crime_col"] and any(k in c_lower for k in ["범죄율", "범죄발생", "발생건수", "1만명당", "crime"]):
            mapping["crime_col"] = c_str
        # 인구수 열 감지
        if not mapping["pop_col"] and any(k in c_lower for k in ["인구", "인구수", "주민", "pop"]):
            mapping["pop_col"] = c_str
        # 특이사항 열 감지
        if not mapping["note_col"] and any(k in c_lower for k in ["특이", "비고", "메모", "note", "desc"]):
            mapping["note_col"] = c_str
            
    # 감지되지 않은 필수 컬럼에 대한 기본값 부여
    if not mapping["region_col"] and len(cols) > 0:
        mapping["region_col"] = cols[0]
    if not mapping["budget_col"] and len(cols) > 1:
        mapping["budget_col"] = cols[1]
    if not mapping["crime_col"] and len(cols) > 2:
        mapping["crime_col"] = cols[2]
        
    return mapping

@app.route("/")
def index():
    """메인 대시보드 뷰 페이지 렌더링"""
    excel_file = find_excel_file()
    file_status = {
        "found": excel_file is not None,
        "filename": excel_file if excel_file else "파일 없음"
    }
    return render_template("index.html", file_status=file_status)

@app.route("/load-data", methods=["GET"])
def load_data():
    """엑셀 데이터를 읽고 정제하여 테이블 미리보기 및 컬럼 목록을 반환합니다."""
    excel_file = find_excel_file()
    if not excel_file:
        logger.warning("엑셀 데이터 파일 탐색 실패: 지원되는 .xlsx/.csv 파일 없음")
        return jsonify({
            "success": False,
            "error": "프로젝트 폴더 안에 분석할 엑셀 데이터 파일(crime_data.xlsx 등)이 존재하지 않습니다. 파일을 폴더에 넣어주세요."
        }), 404
        
    try:
        # 파일 확장자에 따른 로드
        if excel_file.endswith(".csv"):
            try:
                df = pd.read_csv(excel_file, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(excel_file, encoding="cp949")
        else:
            df = pd.read_excel(excel_file, engine="openpyxl")
            
        total_raw_rows = len(df)
        if total_raw_rows == 0:
            return jsonify({
                "success": False,
                "error": f"'{excel_file}' 파일에 데이터가 비어 있습니다."
            }), 400
            
        mapping = auto_detect_columns(df)
        
        # 결측치 정제
        df_clean = df.dropna(how="all")
        missing_count = total_raw_rows - len(df_clean)
        
        # 미리보기용 데이터 (최대 30개 행)
        records = df_clean.head(30).to_dict(orient="records")
        
        # 컬럼 목록과 타입
        columns = df.columns.tolist()
        
        logger.info(f"데이터 로드 성공 | 파일: {excel_file} | 행 수: {len(df_clean)} (결측치 제외: {missing_count}행)")
        
        return jsonify({
            "success": True,
            "filename": excel_file,
            "total_rows": len(df_clean),
            "missing_count": missing_count,
            "columns": columns,
            "mapping": mapping,
            "records": records
        })
        
    except Exception as e:
        logger.error(f"데이터 로드 중 예외 발생: {str(e)}")
        return jsonify({
            "success": False,
            "error": f"데이터 파일을 읽는 중 오류가 발생했습니다: {str(e)}"
        }), 500

@app.route("/generate", methods=["POST"])
def generate():
    """피어슨 상관계수 및 통계 지표를 계산하고, Gemini AI 리포트를 생성합니다."""
    excel_file = find_excel_file()
    if not excel_file:
        return jsonify({
            "success": False,
            "error": "분석할 데이터 파일이 존재하지 않습니다."
        }), 400
        
    req_data = request.get_json() or {}
    analysis_mode = req_data.get("mode", "A") # A: 학술·통계 분석형, B: 지자체 정책 컨설팅형
    control_type = req_data.get("control_type", "total") # total vs per_capita
    
    try:
        if excel_file.endswith(".csv"):
            try:
                df = pd.read_csv(excel_file, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(excel_file, encoding="cp949")
        else:
            df = pd.read_excel(excel_file, engine="openpyxl")
            
        mapping = auto_detect_columns(df)
        region_col = req_data.get("region_col") or mapping["region_col"]
        budget_col = req_data.get("budget_col") or mapping["budget_col"]
        crime_col = req_data.get("crime_col") or mapping["crime_col"]
        pop_col = req_data.get("pop_col") or mapping["pop_col"]
        note_col = req_data.get("note_col") or mapping["note_col"]
        
        # 필수 열 검증
        if not region_col or region_col not in df.columns:
            return jsonify({"success": False, "error": f"지자체명을 나타내는 '{region_col}' 열을 찾을 수 없습니다."}), 400
        if not budget_col or budget_col not in df.columns:
            return jsonify({"success": False, "error": f"예산액을 나타내는 '{budget_col}' 열을 찾을 수 없습니다."}), 400
        if not crime_col or crime_col not in df.columns:
            return jsonify({"success": False, "error": f"범죄 관련 수치를 나타내는 '{crime_col}' 열을 찾을 수 없습니다."}), 400

        # 필요한 컬럼만 추출 및 유효성 검증
        df_work = df.copy()
        df_work[budget_col] = pd.to_numeric(df_work[budget_col], errors="coerce")
        df_work[crime_col] = pd.to_numeric(df_work[crime_col], errors="coerce")
        if pop_col and pop_col in df_work.columns:
            df_work[pop_col] = pd.to_numeric(df_work[pop_col], errors="coerce")
            
        # 결측치 제거
        df_work = df_work.dropna(subset=[region_col, budget_col, crime_col])
        
        # 최소 3개 이상 지자체 매칭 여부 검증
        if len(df_work) < 3:
            return jsonify({
                "success": False,
                "error": f"통계적 상관분석을 수행하기 위해서는 최소 3개 이상의 유효한 지자체 데이터가 필요합니다. (현재 유효 데이터: {len(df_work)}건)"
            }), 400
            
        # 인구 1인당 표준화 변수 계산 (요청 시)
        if control_type == "per_capita" and pop_col and pop_col in df_work.columns:
            df_work["x_val"] = df_work[budget_col] / df_work[pop_col].replace(0, np.nan)
            df_work["x_label"] = "1인당 범죄예방예산(원/명)"
            # 만약 crime_col이 총 발생건수라면 1만명당 범죄율로 환산
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

        # 1. 수학적 통계 연산 (피어슨 상관계수 r)
        r = float(df_work["x_val"].corr(df_work["y_val"]))
        if math.isnan(r):
            r = 0.0
            
        # 상관계수 강도 해석
        abs_r = abs(r)
        if abs_r >= 0.7:
            r_strength = "매우 강한 상관관계"
        elif abs_r >= 0.4:
            r_strength = "뚜렷한 상관관계"
        elif abs_r >= 0.2:
            r_strength = "약한 상관관계"
        else:
            r_strength = "상관관계 거의 없음 (독립적 경향)"
            
        r_direction = "양(+)의 상관" if r > 0 else ("음(-)의 상관" if r < 0 else "무상관")
        
        # 평균 및 표준편차
        x_mean = float(df_work["x_val"].mean())
        x_std = float(df_work["x_val"].std())
        y_mean = float(df_work["y_val"].mean())
        y_std = float(df_work["y_val"].std())
        
        # 지자체별 투입 효율성 산출
        # 예산 대비 범죄 억제 효율: 예산 1억 원당 범죄율 (또는 총예산 대비 범죄율 지표)
        # 범죄율이 낮으면서 예산도 적게 쓴 지역이 '고효율(저비용 고치안)'
        df_work["efficiency_ratio"] = df_work["y_val"] / (df_work["x_val"] / 100000000.0) # 1억 원당 범죄 지표
        
        sorted_by_eff = df_work.sort_values(by="efficiency_ratio", ascending=True)
        top_efficiency = sorted_by_eff.head(3)[[region_col, "x_val", "y_val", "efficiency_ratio"]].to_dict(orient="records")
        bottom_efficiency = sorted_by_eff.tail(3)[[region_col, "x_val", "y_val", "efficiency_ratio"]].to_dict(orient="records")
        
        # 1억 원당 범죄율 증감 기울기 (1차 선형 회귀 기울기)
        slope = float(r * (y_std / x_std)) if x_std > 0 else 0.0
        delta_per_100m = slope * 100000000.0 # 예산 1억 원 투입 시 예상되는 범죄율 변동분
        
        # 안전한 백엔드 로그 기록
        logger.info(f"통계 연산 완료 | 파일: {excel_file} | 데이터 건수: {n}건 | 상관계수 r: {r:.4f} ({r_direction}, {r_strength})")

        # 프론트엔드 차트용 데이터 배열
        chart_points = []
        for _, row in df_work.iterrows():
            note_val = str(row[note_col]) if note_col and note_col in df_work.columns and pd.notna(row[note_col]) else ""
            chart_points.append({
                "x": float(row["x_val"]),
                "y": float(row["y_val"]),
                "region": str(row[region_col]),
                "note": note_val
            })

        # 2. Gemini AI 심층 리포트 생성
        stats_summary_text = f"""
[분석 대상 데이터 요약]
- 분석 대상 파일: {excel_file}
- 분석 지자체 표본 수: {n}개 지자체
- 분석 변수: X = {df_work['x_label'].iloc[0]}, Y = {df_work['y_label'].iloc[0]}
- 피어슨 상관계수 (r): {r:.4f} ({r_direction}, {r_strength})
- X (예산) 평균: {x_mean:,.0f}원 (표준편차: {x_std:,.0f}원)
- Y (범죄) 평균: {y_mean:,.2f} (표준편차: {y_std:,.2f})
- 1차 선형 회귀 기울기 기준 예산 1억 원당 범죄지표 변동 예측치: {delta_per_100m:+.2f}

[지자체 투입 효율성 순위]
- 최고 효율 지자체 TOP 3 (저비용-저범죄율): {', '.join([f"{item[region_col]} ({item['y_val']:.1f}건)" for item in top_efficiency])}
- 예산 대비 범죄 집중 지자체 (고예산-고범죄율 또는 저효율): {', '.join([f"{item[region_col]} ({item['y_val']:.1f}건)" for item in bottom_efficiency])}
"""

        if analysis_mode == "A":
            prompt = f"""당신은 계량행정학 및 공공데이터 통계 분석 권위자입니다.
아래 제공된 '지자체별 범죄예방 예산 및 범죄율 상관분석 실측치'를 바탕으로 **[학술·통계 분석형 심층 리포트]**를 마크다운(Markdown) 포맷으로 명확하고 체계적으로 작성하세요.

{stats_summary_text}

[리포트 필수 작성 요구사항]
1. **피어슨 상관계수($r = {r:.4f}$)의 수학적 의미와 유의성 정밀 진단**:
   - 상관계수의 부호와 크기가 의미하는 통계적 관계
2. **산점도 및 회귀 추세선 경향 분석**:
   - 데이터의 전반적 산포 양상 및 선형 추세선과의 일치도
3. **역인과성(Reverse Causality) 및 내생성(Endogeneity) 규명**:
   - 만약 양(+)의 상관이 나타났다면 왜 "예산이 증가해서 범죄가 늘어난 것"이 아니라 "범죄가 잦은 고위험 지역에 예산을 집중 투입한 결과(역인과성)"인지 통계학적 논리로 정밀 해설
   - 유동인구, 중심상업지구 비율, 야간 공동화 등 외생적 통제 변수의 필요성 논증
4. **결측치 및 극단치(이상치) 지자체 해석**:
   - 고효율 및 특이 지자체의 데이터 분포 특성 진단
5. **학술적 결론 및 연구적 시사점**:
   - 지자체 치안 행정 연구를 위한 제언

답변은 전문적이며 공공데이터 정책 연구 논문 수준의 품격 있는 어조로 작성해주세요.
"""
        else:
            prompt = f"""당신은 행정안전부 및 지방자치단체 재정 치안 정책 수석 컨설턴트입니다.
아래 제공된 '지자체별 범죄예방 예산 및 범죄율 상관분석 실측치'를 바탕으로 **[지자체 정책 컨설팅 및 차년도 예산 재배분 전략 가이드]**를 마크다운(Markdown) 포맷으로 작성하세요.

{stats_summary_text}

[리포트 필수 작성 요구사항]
1. **현행 범죄예방 예산 집행의 효율성 종합 진단**:
   - 상관계수($r = {r:.4f}$)와 1억 원당 범죄율 변동치({delta_per_100m:+.2f})를 바탕으로 한 지자체 치안 재정 투입의 현실적 성과 진단
2. **지자체별 치안 예산 투입 효율성 벤치마킹 분석**:
   - 최고 효율 지자체({', '.join([item[region_col] for item in top_efficiency])})의 성공 요인 (CCTV 스마트관제 효율화, 셉테드(CPTED) 설계 등)
   - 최저 효율 및 개선 요망 지자체({', '.join([item[region_col] for item in bottom_efficiency])})의 예산 누수 요인 진단
3. **사업별 예산 낭비 요인 및 사각지대 개선안**:
   - 단순 하드웨어 설치 중심 지출 탈피 방안 및 데이터 기반 방범 인프라 재배치
4. **차년도 예산 최적 재배분(Reallocation) 실행 로드맵**:
   - 범죄 다발 지역과 인구 밀집 지역 간 예산 차등 지원 기준표 제시
   - 차년도 예산 심의 시 반영해야 할 정량적 KPI 가이드

공무원과 정책 입안자가 즉각 활용할 수 있도록 실천적이고 명확한 정책 제언을 제공해주세요.
"""

        ai_report = ""
        # Gemini API 호출 (공식 google-genai SDK)
        if GEMINI_API_KEY and GEMINI_API_KEY != "your_gemini_api_key_here":
            try:
                from google import genai
                client = genai.Client(api_key=GEMINI_API_KEY)
                response = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt
                )
                ai_report = response.text
                logger.info("Gemini API 호출 및 AI 리포트 생성 완료")
            except Exception as api_err:
                logger.error(f"Gemini API 호출 실패: {str(api_err)}")
                ai_report = f"> [!WARNING] Gemini API 호출 중 오류가 발생했습니다: {str(api_err)}\n\n" + generate_fallback_report(analysis_mode, r, r_direction, r_strength, top_efficiency, bottom_efficiency, region_col, delta_per_100m)
        else:
            logger.info("GEMINI_API_KEY 미설정 - 정밀 통계 지표 기반 자체 분석 리포트 생성")
            ai_report = generate_fallback_report(analysis_mode, r, r_direction, r_strength, top_efficiency, bottom_efficiency, region_col, delta_per_100m)

        return jsonify({
            "success": True,
            "stats": {
                "r": round(r, 4),
                "r_strength": r_strength,
                "r_direction": r_direction,
                "sample_count": n,
                "x_label": df_work["x_label"].iloc[0],
                "y_label": df_work["y_label"].iloc[0],
                "x_mean": x_mean,
                "y_mean": y_mean,
                "delta_per_100m": round(delta_per_100m, 2),
                "top_efficiency": top_efficiency,
                "bottom_efficiency": bottom_efficiency
            },
            "chart_data": chart_points,
            "report_markdown": ai_report
        })

    except Exception as e:
        logger.error(f"상관분석 및 리포트 생성 중 예외 발생: {str(e)}")
        return jsonify({
            "success": False,
            "error": f"분석 중 오류가 발생했습니다: {str(e)}"
        }), 500

def generate_fallback_report(mode, r, direction, strength, top_eff, bottom_eff, region_col, delta):
    """API 키 미등록 시에도 통계적 수치에 기반한 충실한 리포트를 자동 생성합니다."""
    top_str = ", ".join([f"**{item[region_col]}**" for item in top_eff])
    bottom_str = ", ".join([f"**{item[region_col]}**" for item in bottom_eff])
    
    if mode == "A":
        return f"""### 📊 학술·통계 분석형 심층 리포트 (통계 엔진 자동 연산)

> [!NOTE] `.env` 파일에 유효한 `GEMINI_API_KEY`를 등록하시면 Gemini 생성형 AI의 문맥 기반 정책 분석이 추가로 통합 제공됩니다.

#### 1. 피어슨 상관계수($r = {r:.4f}$)의 수학적 의미
- 산출된 상관계수는 **{r:.4f}**로, 두 변수 간에는 **'{strength}'** 및 **'{direction}'**의 통계적 경향성을 나타내고 있습니다.
- 이는 예산 지출 규모와 지자체별 범죄 발생 지표 간에 선형적 연관성이 관측됨을 의미합니다.

#### 2. 역인과성(Reverse Causality) 및 내생성 분석
- 공공 안전 및 치안 정책 분석에서 예산과 범죄율 간의 양(+)의 상관관계가 나타나는 주된 요인은 **역인과성(Reverse Causality)**에 기인합니다.
- 즉, '예산을 많이 투입해서 범죄가 증가한 것'이 아니라, **'범죄 발생 위험이 높거나 유동인구가 집중되는 취약 지자체에 정책적·재정적 예산이 사후적으로 집중 배정'**되었기 때문입니다.
- 따라서 단순 총액 비교보다는 주간 유동인구, 상업지 비율, 1인 가구 비율 등의 외생변수를 통제한 정밀 패널 분석이 요구됩니다.

#### 3. 지자체별 효율성 분포 및 이상치 해석
- **고효율 지자체군 ({top_str})**: 적정 수준의 예산 투입 대비 상대적으로 낮은 범죄 발생 지표를 유지하여 치안 안전망이 우수하게 작동하는 권역입니다.
- **예산 집중 지자체군 ({bottom_str})**: 대규모 도심 상권이나 유흥가 밀집 등 구조적 치안 취약 요인으로 인해 높은 예산 배정에도 불구하고 지속적인 집중 관리가 필요한 지역입니다.
"""
    else:
        return f"""### 🏛️ 지자체 정책 컨설팅 및 차년도 예산 재배분 가이드 (통계 엔진 자동 연산)

> [!NOTE] `.env` 파일에 유효한 `GEMINI_API_KEY`를 등록하시면 Gemini 생성형 AI의 문맥 기반 정책 분석이 추가로 통합 제공됩니다.

#### 1. 치안 예산 집행 성과 및 현주소 진단
- 피어슨 상관계수: **{r:.4f}** ({strength})
- 1차 선형 회귀 추세선 기준, 예산 1억 원 증액 시 범죄지표 기대 변동량은 **{delta:+.2f}** 단위로 관측되었습니다.
- 지자체별 치안 환경 편차가 크므로 일괄적 균등 배분 방식의 예산 편성은 실효성이 제한적입니다.

#### 2. 우수 지자체 벤치마킹 및 예산 효율화
- **우수 권역**: {top_str}
  - 셉테드(CPTED) 디자인 적용 및 지능형 선별관제 CCTV 시스템의 효율적 배치 노하우를 인근 지자체로 전파할 필요가 있습니다.
- **예산 사각지대 권역**: {bottom_str}
  - 단순 방범 인프라 증설을 넘어 야간 안심귀갓길 순찰대 연계, 상권 밀집지역 시간대별 기동 순찰 등 소프트웨어적 치안 대응이 시급합니다.

#### 3. 차년도 예산 재배분 정책 제언
1. **데이터 기반 차등 배분**: 야간 생활인구 및 5대 범죄 발생 히트맵에 근거한 목적형 특별교부세 확대
2. **성과 연동형 예산제 도입**: 단순 예산 집행률이 아닌 '인구 대비 범죄 억제율' 및 '주민 체감 안전도' 지표를 차년도 예산 심의에 30% 이상 반영
"""

if __name__ == "__main__":
    logger.info("Crime Budget Analyzer 서버 시작 (http://127.0.0.1:5000)")
    app.run(host="127.0.0.1", port=5000, debug=True)
