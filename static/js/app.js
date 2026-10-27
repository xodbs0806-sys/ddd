/**
 * AI Crime Budget & Rate Easy Analyzer - Nationwide & Regional Script
 * 전국 229개 시·군·구 지원 및 쉬운 일상 언어
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

    const selectSido = document.getElementById("selectSido");
    if (selectSido) selectSido.addEventListener("change", function () {
        filterTableBySido();
        runAnalysis();
    });

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
 * 금액 단위 포맷팅 함수 (억 원 / 만 원)
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
 * 데이터 로드
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
                fileBadgeText.textContent = "파일 오류: " + data.error;
            }
            return;
        }

        currentRawData = data;
        if (fileBadge) {
            fileBadge.className = "file-status-badge badge-active";
            fileBadgeText.innerHTML = `분석 파일: <strong>${data.filename}</strong> (전국 ${data.total_rows}개 동네)`;
        }
        if (countBadge) countBadge.textContent = `전국 ${data.total_rows}개 동네 로드됨`;

        filterTableBySido();
        runAnalysis();

    } catch (err) {
        console.error("데이터 로드 오류:", err);
        showToast("데이터를 읽어오는 중 문제가 발생했습니다.", "error");
    }
}

/**
 * 선택된 시·도에 따라 미리보기 테이블 필터링
 */
function filterTableBySido() {
    if (!currentRawData || !currentRawData.records) return;

    const selectSido = document.getElementById("selectSido");
    const chosen = selectSido ? selectSido.value : "ALL";
    const mapping = currentRawData.mapping;

    let filtered = currentRawData.records;
    if (chosen !== "ALL") {
        filtered = filtered.filter(row => {
            const sidoVal = mapping.sido_col ? String(row[mapping.sido_col]) : "";
            const regVal = mapping.region_col ? String(row[mapping.region_col]) : "";
            return sidoVal === chosen || regVal.startsWith(chosen);
        });
    }

    renderPreviewTable(filtered, mapping);
}

function renderPreviewTable(records, mapping) {
    const tbody = document.getElementById("tableBody");
    if (!tbody || !records || records.length === 0) return;

    const sidoCol = mapping.sido_col;
    const regCol = mapping.region_col;
    const budCol = mapping.budget_col;
    const crmCol = mapping.crime_col;
    const popCol = mapping.pop_col;
    const notCol = mapping.note_col;

    let html = "";
    // 최대 40개 표시
    records.slice(0, 40).forEach(row => {
        const rawBudget = Number(row[budCol]) || 0;
        const formattedBudget = formatKoreanCurrency(rawBudget);
        const crimeVal = row[crmCol] !== undefined ? Number(row[crmCol]).toLocaleString() + "건" : "-";
        const popVal = popCol && row[popCol] ? Number(row[popCol]).toLocaleString() + "명" : "-";
        const noteVal = notCol && row[notCol] ? row[notCol] : "-";
        const sidoVal = sidoCol && row[sidoCol] ? row[sidoCol] : "-";

        html += `
            <tr>
                <td><span class="count-badge">${sidoVal}</span></td>
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
 * 1차 선형 회귀 흐름선 연산
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
 * Chart.js 4사분면 그래프 렌더링
 */
function renderChart(chartPoints, xLabel, yLabel) {
    const canvas = document.getElementById("correlationChart");
    if (!canvas) return;

    if (window.correlationChartInstance) {
        window.correlationChartInstance.destroy();
        window.correlationChartInstance = null;
    }

    const trendlinePoints = calculateLinearRegression(chartPoints);
    const ctx = canvas.getContext("2d");
    const pointColors = chartPoints.map(p => p.quad_color || "#2563eb");

    window.correlationChartInstance = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "우리 동네 위치",
                    data: chartPoints,
                    backgroundColor: pointColors,
                    borderColor: "#ffffff",
                    borderWidth: 1.5,
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    order: 2
                },
                {
                    label: "전체적인 평균 흐름선",
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
            maintainAspectRatio: false,
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
                            return "전체적인 평균 흐름선";
                        },
                        label: function (context) {
                            const raw = context.raw;
                            if (raw.region) {
                                const formattedBudget = formatKoreanCurrency(raw.x);
                                return [
                                    ` 💰 예산: ${formattedBudget}`,
                                    ` 🚨 범죄: ${raw.y.toFixed(1)}건`,
                                    raw.note ? ` 📍 특성: ${raw.note}` : ""
                                ].filter(Boolean);
                            } else {
                                return ` 평균 흐름 (예산: ${formatKoreanCurrency(raw.x)}, 예상 범죄: ${raw.y.toFixed(1)}건)`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: xLabel || "방범 예산 (오른쪽으로 갈수록 돈을 많이 씀)",
                        font: { size: 12, weight: "600" },
                        color: "#475569"
                    },
                    grid: { color: "#f1f5f9" },
                    ticks: {
                        color: "#64748b",
                        callback: function (value) {
                            return formatKoreanCurrency(value);
                        }
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: yLabel || "범죄 발생 건수 (위로 갈수록 사건이 많음)",
                        font: { size: 12, weight: "600" },
                        color: "#475569"
                    },
                    grid: { color: "#f1f5f9" },
                    ticks: {
                        color: "#64748b",
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
 * 분석 실행 (/generate)
 */
async function runAnalysis() {
    const analysisMode = document.getElementById("analysisMode").value;
    const controlType = document.getElementById("controlType").value;
    const selectSido = document.getElementById("selectSido");
    const selectedSido = selectSido ? selectSido.value : "ALL";
    const chkExclude = document.getElementById("chkExcludeCommercial");
    const excludeCommercial = chkExclude ? chkExclude.checked : false;

    const loadingOverlay = document.getElementById("loadingOverlay");
    const reportViewer = document.getElementById("reportViewer");
    const reportBadge = document.getElementById("reportModeBadge");
    const targetRegionSpan = document.getElementById("verdictTargetRegion");

    const sidoNames = {
        "ALL": "대한민국 전국",
        "서울": "서울특별시", "경기": "경기도", "부산": "부산광역시", "대구": "대구광역시",
        "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시",
        "세종": "세종시", "강원": "강원도", "충북": "충청북도", "충남": "충청남도",
        "전북": "전라북도", "전남": "전라남도", "경북": "경상북도", "경남": "경상남도", "제주": "제주도"
    };

    if (targetRegionSpan) {
        targetRegionSpan.textContent = sidoNames[selectedSido] || selectedSido;
    }

    if (reportBadge) {
        reportBadge.textContent = analysisMode === "A" ? `쉬운 해설형 (${sidoNames[selectedSido] || selectedSido})` : `동네 처방전형 (${sidoNames[selectedSido] || selectedSido})`;
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
                selected_sido: selectedSido,
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

        updateHypothesisUI(resData.stats, resData.target_region_label);
        renderChart(resData.chart_data, resData.stats.x_label, resData.stats.y_label);

        currentGeneratedMarkdown = resData.report_markdown;
        if (typeof marked !== "undefined") {
            reportViewer.innerHTML = marked.parse(currentGeneratedMarkdown);
        } else {
            reportViewer.innerText = currentGeneratedMarkdown;
        }

        showToast(`${resData.target_region_label} 분석이 완료되었습니다!`, "success");

    } catch (err) {
        console.error("분석 에러:", err);
        showToast("분석 중 통신 오류가 발생했습니다.", "error");
    } finally {
        if (loadingOverlay) loadingOverlay.style.display = "none";
        if (reportViewer) reportViewer.style.opacity = "1";
    }
}

/**
 * 쉬운 UI 텍스트 업데이트
 */
function updateHypothesisUI(stats, regionLabel) {
    const verdictBanner = document.getElementById("verdictBanner");
    const verdictTitle = document.getElementById("verdictTitle");
    const verdictDesc = document.getElementById("verdictDesc");
    const valR = document.getElementById("valCorrelationR");
    const valRDesc = document.getElementById("valCorrelationRDesc");
    const valDelta = document.getElementById("valDeltaPer100M");
    const valModelCount = document.getElementById("valModelCount");

    if (verdictTitle) verdictTitle.textContent = stats.hypothesis_verdict;
    if (verdictDesc) {
        if (stats.r > 0) {
            verdictDesc.textContent = `${regionLabel} ${stats.sample_count}개 동네 분석 결과, 사람이 붐비고 위험한 번화가에 구청과 경찰이 예산을 더 많이 쏟아붓고 있어 '치안 예산의 역설'이 나타납니다.`;
        } else {
            verdictDesc.textContent = `${regionLabel} ${stats.sample_count}개 동네 분석 결과, 예산을 많이 들인 동네일수록 범죄 예방 시설이 잘 갖춰져 범죄가 줄어드는 좋은 효과가 나타나고 있습니다.`;
        }
    }

    if (verdictBanner) {
        verdictBanner.className = "verdict-banner card verdict-" + (stats.verdict_badge || "warning");
    }

    if (valR) {
        valR.textContent = (stats.r >= 0 ? "+" : "") + stats.r.toFixed(2);
        valR.style.color = stats.r >= 0 ? "#b45309" : "#047857";
    }
    if (valRDesc) {
        valRDesc.textContent = stats.r > 0 ? "예산 많을수록 범죄도 많음" : "예산 많을수록 범죄 줄어듦";
    }

    if (valDelta) {
        valDelta.textContent = (stats.delta_per_100m >= 0 ? "+" : "") + stats.delta_per_100m + "건";
    }

    const q = stats.quadrants || {};
    const q4Count = q.q4_effective ? q.q4_effective.length : 0;
    if (valModelCount) valModelCount.textContent = `${q4Count}개 동네`;

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
        showToast("복사할 내용이 없습니다.", "info");
        return;
    }
    navigator.clipboard.writeText(currentGeneratedMarkdown).then(() => {
        showToast("설명글이 클립보드에 복사되었습니다!", "success");
    }).catch(() => {
        showToast("복사 중 오류가 발생했습니다.", "error");
    });
}

function downloadMarkdownFile() {
    if (!currentGeneratedMarkdown) {
        showToast("다운로드할 내용이 없습니다.", "info");
        return;
    }
    const blob = new Blob([currentGeneratedMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `우리동네_범죄예방_분석리포트_${now}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("파일(.md) 다운로드가 완료되었습니다.", "success");
}

function showToast(message, type = "info") {
    const toast = document.getElementById("toastMessage");
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === "error" ? "#dc2626" : (type === "success" ? "#16a34a" : "#0f172a");
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 3200);
}
