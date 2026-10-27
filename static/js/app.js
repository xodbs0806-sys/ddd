/**
 * AI Crime Budget & Rate Excel Analyzer - Frontend Logic
 * Pure JavaScript Implementation (No external trendline plugin dependency)
 */

// 전역 차트 인스턴스 보관 객체
window.correlationChartInstance = null;
let currentRawData = null;
let currentGeneratedMarkdown = "";

document.addEventListener("DOMContentLoaded", function () {
    // 1. 이벤트 리스너 등록
    initEventListeners();

    // 2. 초기 엑셀 데이터 자동 로드
    fetchExcelData();
});

function initEventListeners() {
    // 데이터 다시 읽기 버튼
    const btnReload = document.getElementById("btnReloadData");
    if (btnReload) {
        btnReload.addEventListener("click", fetchExcelData);
    }

    // 상관분석 및 AI 리포트 생성 버튼
    const btnAnalyze = document.getElementById("btnAnalyze");
    if (btnAnalyze) {
        btnAnalyze.addEventListener("click", runAnalysis);
    }

    // 아코디언 테이블 토글
    const accordionToggle = document.getElementById("accordionToggle");
    const accordionContent = document.getElementById("accordionContent");
    const accordionArrow = document.getElementById("accordionArrow");
    if (accordionToggle && accordionContent && accordionArrow) {
        accordionToggle.addEventListener("click", function () {
            accordionContent.classList.toggle("open");
            accordionArrow.classList.toggle("open");
        });
    }

    // 리포트 클립보드 복사
    const btnCopy = document.getElementById("btnCopyReport");
    if (btnCopy) {
        btnCopy.addEventListener("click", copyReportToClipboard);
    }

    // 마크다운(.md) 파일 다운로드
    const btnDownload = document.getElementById("btnDownloadReport");
    if (btnDownload) {
        btnDownload.addEventListener("click", downloadMarkdownFile);
    }
}

/**
 * 1. 통화/예산 금액 단위 자동 축약 포맷팅 함수 (요구사항)
 * 1억 원 이상: (amount / 100000000).toFixed(1) + '억 원'
 * 1억 원 미만: (amount / 10000).toLocaleString() + '만 원'
 */
function formatKoreanCurrency(amount) {
    if (isNaN(amount) || amount === null || amount === undefined) {
        return "-";
    }

    const num = Number(amount);
    const absVal = Math.abs(num);
    const sign = num < 0 ? "-" : "";

    if (absVal >= 100000000) {
        // 1억 원 이상
        const in100M = absVal / 100000000;
        // 소수점 첫째 자리가 0이면 깔끔하게 정수로 표기 (예: 120.0 -> 120억 원 or 125.4억 원)
        const formatted = Number.isInteger(in100M) ? in100M.toLocaleString() : in100M.toFixed(1);
        return `${sign}${formatted}억 원`;
    } else if (absVal >= 10000) {
        // 1만 원 이상 ~ 1억 원 미만
        const in10K = Math.round(absVal / 10000);
        return `${sign}${in10K.toLocaleString()}만 원`;
    } else {
        return `${sign}${Math.round(absVal).toLocaleString()}원`;
    }
}

/**
 * 2. 엑셀 데이터 비동기 로드 (/load-data)
 */
async function fetchExcelData() {
    const tableBody = document.getElementById("tableBody");
    const countBadge = document.getElementById("dataCountBadge");
    const fileBadgeText = document.getElementById("fileStatusText");
    const fileBadge = document.getElementById("fileStatusBadge");

    try {
        const response = await fetch("/load-data");
        const data = await response.json();

        if (!data.success) {
            showToast(data.error, "error");
            if (fileBadge) {
                fileBadge.className = "file-status-badge badge-inactive";
                fileBadgeText.textContent = "엑셀 파일 오류: " + data.error;
            }
            return;
        }

        currentRawData = data;

        // 헤더 뱃지 갱신
        if (fileBadge) {
            fileBadge.className = "file-status-badge badge-active";
            fileBadgeText.innerHTML = `데이터 파일 인식됨: <strong>${data.filename}</strong> (${data.total_rows}개 지자체)`;
        }
        if (countBadge) {
            countBadge.textContent = `${data.total_rows}건 로드됨`;
        }

        // 미리보기 테이블 렌더링
        renderPreviewTable(data.records, data.mapping);

        // 초기 차트 및 분석 자동 트리거
        runAnalysis();

    } catch (err) {
        console.error("데이터 로드 중 통신 오류:", err);
        showToast("데이터 파일을 불러오는 중 통신 오류가 발생했습니다.", "error");
    }
}

/**
 * 원본 데이터 테이블 렌더링 (억 원 병기 및 오른쪽 정렬)
 */
function renderPreviewTable(records, mapping) {
    const tbody = document.getElementById("tableBody");
    if (!tbody || !records || records.length === 0) return;

    const regCol = mapping.region_col;
    const budCol = mapping.budget_col;
    const crmCol = mapping.crime_col;
    const popCol = mapping.pop_col;
    const notCol = mapping.note_col;

    let html = "";
    records.forEach(row => {
        const rawBudget = Number(row[budCol]) || 0;
        const formattedBudget = formatKoreanCurrency(rawBudget);
        const crimeVal = row[crmCol] !== undefined ? Number(row[crmCol]).toLocaleString() : "-";
        const popVal = popCol && row[popCol] ? Number(row[popCol]).toLocaleString() + "명" : "-";
        const noteVal = notCol && row[notCol] ? row[notCol] : "-";

        html += `
            <tr>
                <td><strong>${row[regCol] || "-"}</strong></td>
                <td class="text-right">${rawBudget.toLocaleString()}원 <span style="color:#2563eb; font-weight:600;">(${formattedBudget})</span></td>
                <td class="text-right">${crimeVal}</td>
                <td class="text-right">${popVal}</td>
                <td>${noteVal}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * 3. 1차 선형 회귀(최소자승법) 추세선 연산 알고리즘 (순수 자바스크립트)
 * X(예산)와 Y(범죄율) 좌표로부터 기울기(m)와 절편(b)을 구하고
 * X의 최솟값과 최댓값을 대입하여 추세선 양 끝점 [{x: Xmin, y: y1}, {x: Xmax, y: y2}] 반환
 */
function calculateLinearRegression(points) {
    if (!points || points.length < 2) return [];

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    const n = points.length;

    for (let i = 0; i < n; i++) {
        const x = points[i].x;
        const y = points[i].y;

        sumX += x;
        sumY += y;
        sumXY += (x * y);
        sumXX += (x * x);

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
    }

    const denominator = (n * sumXX) - (sumX * sumX);
    if (denominator === 0) return []; // X 편차가 없는 경우

    // 기울기(m)과 y절편(b)
    const slope = ((n * sumXY) - (sumX * sumY)) / denominator;
    const intercept = (sumY - (slope * sumX)) / n;

    // 양 끝점 좌표 생성
    const y1 = (slope * minX) + intercept;
    const y2 = (slope * maxX) + intercept;

    return [
        { x: minX, y: y1 },
        { x: maxX, y: y2 }
    ];
}

/**
 * 4. Chart.js 산점도 및 선형 회귀 추세선 렌더링
 */
function renderChart(chartPoints, xLabel, yLabel) {
    const canvas = document.getElementById("correlationChart");
    if (!canvas) return;

    // 차트 인스턴스 생명주기 관리 (Canvas 재사용 에러 완전 차단)
    if (window.correlationChartInstance) {
        window.correlationChartInstance.destroy();
        window.correlationChartInstance = null;
    }

    // 순수 JS 최소자승법 추세선 계산
    const trendlinePoints = calculateLinearRegression(chartPoints);

    const ctx = canvas.getContext("2d");

    window.correlationChartInstance = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "지자체별 관측치",
                    data: chartPoints,
                    backgroundColor: "rgba(37, 99, 235, 0.75)", // 모던 블루
                    borderColor: "#1d4ed8",
                    borderWidth: 1.5,
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    order: 2
                },
                {
                    label: "선형 회귀 추세선 (Trendline)",
                    data: trendlinePoints,
                    type: "line",
                    borderColor: "#dc2626", // 선명한 레드
                    borderWidth: 2.5,
                    borderDash: [6, 6], // 점선 표기
                    pointRadius: 0,     // 추세선에는 점 숨김
                    fill: false,
                    tension: 0,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // .chart-container의 height: 440px에 최적화
            interaction: {
                intersect: false,
                mode: "nearest"
            },
            plugins: {
                legend: {
                    display: false // 카드 상단 커스텀 범례 사용
                },
                tooltip: {
                    backgroundColor: "rgba(15, 23, 42, 0.92)",
                    titleFont: { size: 13, weight: "bold", family: "'Pretendard', sans-serif" },
                    bodyFont: { size: 12, family: "'Pretendard', sans-serif" },
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        title: function (context) {
                            const raw = context[0].raw;
                            if (raw.region) {
                                return raw.region + (raw.note ? ` (${raw.note})` : "");
                            }
                            return "회귀 추세선";
                        },
                        label: function (context) {
                            const raw = context.raw;
                            if (raw.region) {
                                const formattedBudget = formatKoreanCurrency(raw.x);
                                return [
                                    ` 예산액: ${formattedBudget} (${raw.x.toLocaleString()}원)`,
                                    ` 범죄지표: ${raw.y.toFixed(1)}건`
                                ];
                            } else {
                                return ` 추세선 예측치 (예산: ${formatKoreanCurrency(raw.x)}, 지표: ${raw.y.toFixed(1)})`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: xLabel || "지자체 범죄예방 예산",
                        font: { size: 13, weight: "600" },
                        color: "#475569"
                    },
                    grid: {
                        color: "#f1f5f9"
                    },
                    ticks: {
                        color: "#64748b",
                        font: { size: 11 },
                        callback: function (value) {
                            // X축 눈금 긴 숫자를 'OO억 원' 형태로 축약 (요구사항)
                            return formatKoreanCurrency(value);
                        }
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: yLabel || "범죄 발생 수치",
                        font: { size: 13, weight: "600" },
                        color: "#475569"
                    },
                    grid: {
                        color: "#f1f5f9"
                    },
                    ticks: {
                        color: "#64748b",
                        font: { size: 11 },
                        callback: function (value) {
                            return value.toLocaleString() + "건";
                        }
                    }
                }
            }
        }
    });
}

/**
 * 5. 상관분석 및 AI 리포트 생성 (/generate)
 */
async function runAnalysis() {
    const analysisMode = document.getElementById("analysisMode").value;
    const controlType = document.getElementById("controlType").value;
    const loadingOverlay = document.getElementById("loadingOverlay");
    const reportViewer = document.getElementById("reportViewer");
    const reportBadge = document.getElementById("reportModeBadge");

    if (reportBadge) {
        reportBadge.textContent = analysisMode === "A" ? "모드 A: 학술·통계 분석형" : "모드 B: 지자체 정책 컨설팅형";
    }

    if (loadingOverlay) loadingOverlay.style.display = "block";
    if (reportViewer) reportViewer.style.opacity = "0.3";

    try {
        const response = await fetch("/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: analysisMode,
                control_type: controlType
            })
        });

        const resData = await response.json();

        if (!resData.success) {
            showToast(resData.error, "error");
            if (reportViewer) {
                reportViewer.innerHTML = `<div class="report-placeholder" style="color:#dc2626;"><i class="fa-solid fa-circle-exclamation"></i><p>${resData.error}</p></div>`;
            }
            return;
        }

        // 지표 카드 업데이트
        updateSummaryCards(resData.stats);

        // Chart.js 시각화 갱신
        renderChart(resData.chart_data, resData.stats.x_label, resData.stats.y_label);

        // AI 마크다운 리포트 렌더링
        currentGeneratedMarkdown = resData.report_markdown;
        if (typeof marked !== "undefined") {
            reportViewer.innerHTML = marked.parse(currentGeneratedMarkdown);
        } else {
            reportViewer.innerText = currentGeneratedMarkdown;
        }

        showToast("상관분석 및 AI 리포트 생성이 완료되었습니다.", "success");

    } catch (err) {
        console.error("분석 생성 중 오류:", err);
        showToast("분석 요청 중 예기치 않은 오류가 발생했습니다.", "error");
    } finally {
        if (loadingOverlay) loadingOverlay.style.display = "none";
        if (reportViewer) reportViewer.style.opacity = "1";
    }
}

/**
 * 요약 카드 값 업데이트
 */
function updateSummaryCards(stats) {
    const valR = document.getElementById("valCorrelationR");
    const tagStrength = document.getElementById("tagCorrelationStrength");
    const valDelta = document.getElementById("valDeltaPer100M");
    const tagDeltaDesc = document.getElementById("tagDeltaDesc");
    const valTopEff = document.getElementById("valTopEfficiency");
    const valBottomEff = document.getElementById("valBottomEfficiency");

    if (valR) {
        valR.textContent = (stats.r >= 0 ? "+" : "") + stats.r.toFixed(4);
        valR.style.color = stats.r >= 0 ? "#1d4ed8" : "#0f766e";
    }
    if (tagStrength) {
        tagStrength.textContent = `${stats.r_direction} (${stats.r_strength})`;
    }

    if (valDelta) {
        valDelta.textContent = (stats.delta_per_100m >= 0 ? "+" : "") + stats.delta_per_100m + "건";
    }
    if (tagDeltaDesc) {
        tagDeltaDesc.textContent = `표본 ${stats.sample_count}개 지자체`;
    }

    if (valTopEff && stats.top_efficiency && stats.top_efficiency.length > 0) {
        const topList = stats.top_efficiency.map(item => Object.values(item)[0]).slice(0, 2);
        valTopEff.textContent = topList.join(", ");
    }

    if (valBottomEff && stats.bottom_efficiency && stats.bottom_efficiency.length > 0) {
        const bottomList = stats.bottom_efficiency.map(item => Object.values(item)[0]).slice(0, 2);
        valBottomEff.textContent = bottomList.join(", ");
    }
}

/**
 * 리포트 클립보드 복사
 */
function copyReportToClipboard() {
    if (!currentGeneratedMarkdown) {
        showToast("복사할 리포트 내용이 없습니다. 먼저 분석을 진행하세요.", "info");
        return;
    }

    navigator.clipboard.writeText(currentGeneratedMarkdown).then(() => {
        showToast("리포트 전체 내용이 클립보드에 복사되었습니다!", "success");
    }).catch(err => {
        console.error("복사 실패:", err);
        showToast("클립보드 복사 중 오류가 발생했습니다.", "error");
    });
}

/**
 * 마크다운(.md) 파일 즉시 다운로드 기능 (요구사항)
 */
function downloadMarkdownFile() {
    if (!currentGeneratedMarkdown) {
        showToast("다운로드할 리포트가 없습니다.", "info");
        return;
    }

    const blob = new Blob([currentGeneratedMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `Crime_Budget_Correlation_Report_${now}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("마크다운 파일(.md) 다운로드가 시작되었습니다.", "success");
}

/**
 * 토스트 메시지 팝업
 */
function showToast(message, type = "info") {
    const toast = document.getElementById("toastMessage");
    if (!toast) return;

    toast.textContent = message;
    if (type === "error") {
        toast.style.background = "#dc2626";
    } else if (type === "success") {
        toast.style.background = "#16a34a";
    } else {
        toast.style.background = "#0f172a";
    }

    toast.style.display = "block";
    setTimeout(() => {
        toast.style.display = "none";
    }, 3200);
}
