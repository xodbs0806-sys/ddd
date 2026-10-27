/**
 * AI Crime Budget & Rate Paradox Analyzer - Hypothesis Testing Script
 * Pure JavaScript Implementation (No external trendline plugin dependency)
 */

window.correlationChartInstance = null;
let currentRawData = null;
let currentGeneratedMarkdown = "";

document.addEventListener("DOMContentLoaded", function () {
    initEventListeners();
    fetchExcelData();
});

function initEventListeners() {
    const btnReload = document.getElementById("btnReloadData");
    if (btnReload) btnReload.addEventListener("click", fetchExcelData);

    const btnAnalyze = document.getElementById("btnAnalyze");
    if (btnAnalyze) btnAnalyze.addEventListener("click", runAnalysis);

    const chkCommercial = document.getElementById("chkExcludeCommercial");
    if (chkCommercial) chkCommercial.addEventListener("change", runAnalysis);

    const controlSelect = document.getElementById("controlType");
    if (controlSelect) controlSelect.addEventListener("change", runAnalysis);

    const accordionToggle = document.getElementById("accordionToggle");
    const accordionContent = document.getElementById("accordionContent");
    const accordionArrow = document.getElementById("accordionArrow");
    if (accordionToggle && accordionContent && accordionArrow) {
        accordionToggle.addEventListener("click", function () {
            accordionContent.classList.toggle("open");
            accordionArrow.classList.toggle("open");
        });
    }

    const btnCopy = document.getElementById("btnCopyReport");
    if (btnCopy) btnCopy.addEventListener("click", copyReportToClipboard);

    const btnDownload = document.getElementById("btnDownloadReport");
    if (btnDownload) btnDownload.addEventListener("click", downloadMarkdownFile);
}

/**
 * 통화/예산 금액 단위 자동 축약 포맷팅 함수 (1억 원 이상 / 1만 원 단위)
 */
function formatKoreanCurrency(amount) {
    if (isNaN(amount) || amount === null || amount === undefined) return "-";
    const num = Number(amount);
    const absVal = Math.abs(num);
    const sign = num < 0 ? "-" : "";

    if (absVal >= 100000000) {
        const in100M = absVal / 100000000;
        const formatted = Number.isInteger(in100M) ? in100M.toLocaleString() : in100M.toFixed(1);
        return `${sign}${formatted}억 원`;
    } else if (absVal >= 10000) {
        const in10K = Math.round(absVal / 10000);
        return `${sign}${in10K.toLocaleString()}만 원`;
    } else {
        return `${sign}${Math.round(absVal).toLocaleString()}원`;
    }
}

/**
 * 엑셀 데이터 비동기 로드
 */
async function fetchExcelData() {
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
                fileBadgeText.textContent = "엑셀 오류: " + data.error;
            }
            return;
        }

        currentRawData = data;
        if (fileBadge) {
            fileBadge.className = "file-status-badge badge-active";
            fileBadgeText.innerHTML = `데이터 파일: <strong>${data.filename}</strong> (${data.total_rows}개 지자체)`;
        }
        if (countBadge) countBadge.textContent = `${data.total_rows}건 로드됨`;

        renderPreviewTable(data.records, data.mapping);
        runAnalysis();

    } catch (err) {
        console.error("데이터 로드 오류:", err);
        showToast("데이터를 불러오는 중 오류가 발생했습니다.", "error");
    }
}

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
 * 순수 자바스크립트 1차 선형 회귀(최소자승법) 추세선 연산
 */
function calculateLinearRegression(points) {
    if (!points || points.length < 2) return [];

    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    let minX = Infinity, maxX = -Infinity;
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

    const denom = (n * sumXX) - (sumX * sumX);
    if (denom === 0) return [];

    const slope = ((n * sumXY) - (sumX * sumY)) / denom;
    const intercept = (sumY - (slope * sumX)) / n;

    return [
        { x: minX, y: (slope * minX) + intercept },
        { x: maxX, y: (slope * maxX) + intercept }
    ];
}

/**
 * Chart.js 4사분면 산점도 및 선형 회귀 추세선 렌더링
 */
function renderChart(chartPoints, xLabel, yLabel, xMedian, yMedian) {
    const canvas = document.getElementById("correlationChart");
    if (!canvas) return;

    if (window.correlationChartInstance) {
        window.correlationChartInstance.destroy();
        window.correlationChartInstance = null;
    }

    const trendlinePoints = calculateLinearRegression(chartPoints);
    const ctx = canvas.getContext("2d");

    // 4사분면 색상 및 스타일 맵핑
    const pointColors = chartPoints.map(p => p.quad_color || "#2563eb");

    window.correlationChartInstance = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "지자체별 관측치",
                    data: chartPoints,
                    backgroundColor: pointColors,
                    borderColor: "#ffffff",
                    borderWidth: 1.5,
                    pointRadius: 7,
                    pointHoverRadius: 10,
                    order: 2
                },
                {
                    label: "1차 회귀 추세선",
                    data: trendlinePoints,
                    type: "line",
                    borderColor: "#dc2626",
                    borderWidth: 2.5,
                    borderDash: [6, 6],
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // 440px 높이 준수
            interaction: {
                intersect: false,
                mode: "nearest"
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "rgba(15, 23, 42, 0.94)",
                    titleFont: { size: 13, weight: "bold", family: "'Pretendard', sans-serif" },
                    bodyFont: { size: 12, family: "'Pretendard', sans-serif" },
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        title: function (context) {
                            const raw = context[0].raw;
                            if (raw.region) {
                                return `[${raw.region}] ${raw.quad_label}`;
                            }
                            return "회귀 추세선";
                        },
                        label: function (context) {
                            const raw = context.raw;
                            if (raw.region) {
                                const formattedBudget = formatKoreanCurrency(raw.x);
                                return [
                                    ` 예산: ${formattedBudget} (${raw.x.toLocaleString()}원)`,
                                    ` 범죄지표: ${raw.y.toFixed(1)}건`,
                                    raw.note ? ` 특성: ${raw.note}` : ""
                                ].filter(Boolean);
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
                    grid: { color: "#f1f5f9" },
                    ticks: {
                        color: "#64748b",
                        font: { size: 11 },
                        callback: function (value) {
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
                    grid: { color: "#f1f5f9" },
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
 * 가설 실증 분석 실행 (/generate)
 */
async function runAnalysis() {
    const analysisMode = document.getElementById("analysisMode").value;
    const controlType = document.getElementById("controlType").value;
    const chkExclude = document.getElementById("chkExcludeCommercial");
    const excludeCommercial = chkExclude ? chkExclude.checked : false;

    const loadingOverlay = document.getElementById("loadingOverlay");
    const reportViewer = document.getElementById("reportViewer");
    const reportBadge = document.getElementById("reportModeBadge");

    if (reportBadge) {
        reportBadge.textContent = analysisMode === "A" ? "모드 A: 가설 실증·역인과성 학술 검증" : "모드 B: 4사분면 지자체 맞춤 정책 컨설팅";
    }

    if (loadingOverlay) loadingOverlay.style.display = "block";
    if (reportViewer) reportViewer.style.opacity = "0.3";

    try {
        const response = await fetch("/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: analysisMode,
                control_type: controlType,
                exclude_commercial: excludeCommercial
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

        // 가설 검증 결과 및 4사분면 요약 갱신
        updateHypothesisUI(resData.stats);

        // 4사분면 Chart.js 렌더링
        renderChart(resData.chart_data, resData.stats.x_label, resData.stats.y_label, resData.stats.x_median, resData.stats.y_median);

        // AI 마크다운 리포트 렌더링
        currentGeneratedMarkdown = resData.report_markdown;
        if (typeof marked !== "undefined") {
            reportViewer.innerHTML = marked.parse(currentGeneratedMarkdown);
        } else {
            reportViewer.innerText = currentGeneratedMarkdown;
        }

        showToast("가설 검증 및 AI 리포트 생성이 완료되었습니다.", "success");

    } catch (err) {
        console.error("분석 에러:", err);
        showToast("분석 중 통신 오류가 발생했습니다.", "error");
    } finally {
        if (loadingOverlay) loadingOverlay.style.display = "none";
        if (reportViewer) reportViewer.style.opacity = "1";
    }
}

/**
 * 가설 검증 배너 및 4사분면 지자체 리스트 업데이트
 */
function updateHypothesisUI(stats) {
    const verdictBanner = document.getElementById("verdictBanner");
    const verdictTitle = document.getElementById("verdictTitle");
    const verdictDesc = document.getElementById("verdictDesc");
    const valR = document.getElementById("valCorrelationR");
    const valDelta = document.getElementById("valDeltaPer100M");
    const valModelCount = document.getElementById("valModelCount");

    if (verdictTitle) verdictTitle.textContent = stats.hypothesis_verdict;
    if (verdictDesc) {
        if (stats.r > 0) {
            verdictDesc.textContent = `피어슨 상관계수 r = ${stats.r.toFixed(4)}로, 고위험 취약지에 사후 예산이 집중 배정되는 '치안 예산의 역설'이 관측되었습니다.`;
        } else {
            verdictDesc.textContent = `피어슨 상관계수 r = ${stats.r.toFixed(4)}로, 예산 증액에 따른 범죄 억제 경향이 유의미하게 확인되었습니다.`;
        }
    }

    if (verdictBanner) {
        verdictBanner.className = "verdict-banner card verdict-" + (stats.verdict_badge || "warning");
    }

    if (valR) {
        valR.textContent = (stats.r >= 0 ? "+" : "") + stats.r.toFixed(4);
        valR.style.color = stats.r >= 0 ? "#b45309" : "#047857";
    }

    if (valDelta) {
        valDelta.textContent = (stats.delta_per_100m >= 0 ? "+" : "") + stats.delta_per_100m + "건";
    }

    const q = stats.quadrants || {};
    const q4Count = q.q4_effective ? q.q4_effective.length : 0;
    if (valModelCount) valModelCount.textContent = `${q4Count}개 지자체`;

    // 4사분면 지자체 리스트 텍스트 갱신
    const elQ4 = document.getElementById("listQ4");
    const elQ2 = document.getElementById("listQ2");
    const elQ1 = document.getElementById("listQ1");
    const elQ3 = document.getElementById("listQ3");

    if (elQ4) elQ4.textContent = q.q4_effective && q.q4_effective.length > 0 ? q.q4_effective.join(", ") : "해당 없음";
    if (elQ2) elQ2.textContent = q.q2_blindspot && q.q2_blindspot.length > 0 ? q.q2_blindspot.join(", ") : "해당 없음";
    if (elQ1) elQ1.textContent = q.q1_reverse && q.q1_reverse.length > 0 ? q.q1_reverse.join(", ") : "해당 없음";
    if (elQ3) elQ3.textContent = q.q3_peaceful && q.q3_peaceful.length > 0 ? q.q3_peaceful.join(", ") : "해당 없음";
}

function copyReportToClipboard() {
    if (!currentGeneratedMarkdown) {
        showToast("복사할 리포트가 없습니다.", "info");
        return;
    }
    navigator.clipboard.writeText(currentGeneratedMarkdown).then(() => {
        showToast("리포트가 클립보드에 복사되었습니다!", "success");
    }).catch(() => {
        showToast("클립보드 복사 중 오류가 발생했습니다.", "error");
    });
}

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
    a.download = `Crime_Budget_Hypothesis_Report_${now}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("마크다운(.md) 파일이 다운로드되었습니다.", "success");
}

function showToast(message, type = "info") {
    const toast = document.getElementById("toastMessage");
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === "error" ? "#dc2626" : (type === "success" ? "#16a34a" : "#0f172a");
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 3200);
}
