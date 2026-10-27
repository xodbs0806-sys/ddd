/**
 * AI Crime Budget & Rate - Clean Interactive Map & Click-to-View Detail
 * 지도 위의 복잡한 글자들을 걷어내고, 궁금한 동네 클릭 시 상세 정보 즉시 표시
 */

window.mapInstance = null;
window.mapMarkerGroup = null;
window.kakaoMapInstance = null;
window.kakaoMarkerList = [];
window.correlationChartInstance = null;
window.detailBarChartInstance = null;
let currentRawData = null;
let currentGeneratedMarkdown = "";
let currentStatsAverages = { avgX: 1, avgY: 1 };

const SIDO_COORDINATES = {
    "ALL": { center: [36.2, 127.8], zoom: 7, kakaoLevel: 13 },
    "서울": { center: [37.5665, 126.9780], zoom: 11, kakaoLevel: 8 },
    "경기": { center: [37.45, 127.15], zoom: 9, kakaoLevel: 10 },
    "부산": { center: [35.1796, 129.0756], zoom: 11, kakaoLevel: 9 },
    "대구": { center: [35.8714, 128.6014], zoom: 11, kakaoLevel: 9 },
    "인천": { center: [37.4563, 126.7052], zoom: 11, kakaoLevel: 9 },
    "광주": { center: [35.1595, 126.8526], zoom: 12, kakaoLevel: 8 },
    "대전": { center: [36.3504, 127.3845], zoom: 12, kakaoLevel: 8 },
    "울산": { center: [35.5384, 129.3114], zoom: 11, kakaoLevel: 9 },
    "세종": { center: [36.4800, 127.2890], zoom: 12, kakaoLevel: 8 },
    "강원": { center: [37.75, 128.2], zoom: 9, kakaoLevel: 11 },
    "충북": { center: [36.8, 127.7], zoom: 9, kakaoLevel: 11 },
    "충남": { center: [36.6, 126.8], zoom: 9, kakaoLevel: 11 },
    "전북": { center: [35.75, 127.15], zoom: 9, kakaoLevel: 11 },
    "전남": { center: [34.9, 126.9], zoom: 9, kakaoLevel: 11 },
    "경북": { center: [36.4, 128.7], zoom: 9, kakaoLevel: 11 },
    "경남": { center: [35.35, 128.25], zoom: 9, kakaoLevel: 11 },
    "제주": { center: [33.38, 126.55], zoom: 10, kakaoLevel: 9 }
};

document.addEventListener("DOMContentLoaded", function () {
    initMap();
    initEventListeners();
    fetchExcelData();
});

/**
 * 1. 지도 초기화 (도메인 차단 걱정 없는 100% 무료 글로벌 표준 Leaflet + OpenStreetMap)
 */
function initMap() {
    initLeafletMap();
}

function initLeafletMap() {
    const mapEl = document.getElementById("crimeMap");
    if (!mapEl || window.mapInstance) return;

    window.kakaoMapInstance = null;
    mapEl.innerHTML = "";

    window.mapInstance = L.map("crimeMap", {
        center: [36.2, 127.8],
        zoom: 7,
        zoomControl: true
    });

    // 100% 무료, 워터마크 없는 글로벌 표준 OpenStreetMap 타일
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18
    }).addTo(window.mapInstance);

    window.mapMarkerGroup = L.layerGroup().addTo(window.mapInstance);

    setTimeout(() => {
        if (window.mapInstance) {
            window.mapInstance.invalidateSize();
        }
    }, 250);

    if (window.pendingChartPoints) {
        renderMapMarkers(window.pendingChartPoints, window.pendingSido || "ALL");
    }
}

function initEventListeners() {
    const selectSido = document.getElementById("selectSido");
    if (selectSido) {
        selectSido.addEventListener("change", function () {
            runAnalysis();
        });
    }

    const btnCopy = document.getElementById("btnCopyReport");
    if (btnCopy) btnCopy.addEventListener("click", copyReportToClipboard);

    // AI 자유 질문(Q&A) 이벤트 바인딩
    const btnSendQuestion = document.getElementById("btnSendQuestion");
    const inputQuestion = document.getElementById("userQuestionInput");
    if (btnSendQuestion && inputQuestion) {
        btnSendQuestion.addEventListener("click", sendUserQuestion);
        inputQuestion.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                sendUserQuestion();
            }
        });
    }

    // 추천 질문 칩 클릭 시 자동 입력 및 전송
    document.querySelectorAll(".quick-chip").forEach(chip => {
        chip.addEventListener("click", function () {
            const q = this.getAttribute("data-q");
            if (inputQuestion) {
                inputQuestion.value = q;
                sendUserQuestion();
            }
        });
    });
}

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

async function fetchExcelData() {
    try {
        const response = await fetch("/load-data");
        const data = await response.json();
        if (!data.success) {
            showToast(data.error, "error");
            return;
        }
        currentRawData = data;
        runAnalysis();
    } catch (err) {
        console.error("데이터 로드 오류:", err);
    }
}

/**
 * 2. 지도 위 깔끔한 마커 렌더링 & 클릭 시 상세 정보 열기 (핵심 요구사항)
 */
function renderMapMarkers(chartPoints, selectedSido) {
    window.pendingChartPoints = chartPoints;
    window.pendingSido = selectedSido;
    const targetConfig = SIDO_COORDINATES[selectedSido] || SIDO_COORDINATES["ALL"];

    // A. 카카오 지도
    if (window.kakaoMapInstance) {
        if (window.kakaoMarkerList) {
            window.kakaoMarkerList.forEach(m => m.setMap(null));
        }
        window.kakaoMarkerList = [];

        const moveLatLon = new kakao.maps.LatLng(targetConfig.center[0], targetConfig.center[1]);
        window.kakaoMapInstance.setCenter(moveLatLon);
        window.kakaoMapInstance.setLevel(targetConfig.kakaoLevel || 10);

        chartPoints.forEach(pt => {
            if (!pt.lat || !pt.lng) return;

            const position = new kakao.maps.LatLng(pt.lat, pt.lng);

            // 색상별 커스텀 마커 이미지 또는 동그라미 오버레이
            const markerContent = document.createElement("div");
            markerContent.style.width = "18px";
            markerContent.style.height = "18px";
            markerContent.style.borderRadius = "50%";
            markerContent.style.backgroundColor = pt.quad_color || "#3b82f6";
            markerContent.style.border = "2px solid #ffffff";
            markerContent.style.boxShadow = "0 2px 5px rgba(0,0,0,0.3)";
            markerContent.style.cursor = "pointer";
            markerContent.title = pt.region;

            // 클릭 이벤트: 오른쪽에 상세 정보 표시
            markerContent.addEventListener("click", function () {
                displaySelectedDetail(pt);
            });

            const customMarker = new kakao.maps.CustomOverlay({
                position: position,
                content: markerContent,
                yAnchor: 0.5
            });

            customMarker.setMap(window.kakaoMapInstance);
            window.kakaoMarkerList.push(customMarker);
        });

        // 초기 기본 선택: 첫 번째 동네 자동 표시
        if (chartPoints.length > 0) {
            displaySelectedDetail(chartPoints[0]);
        }
        return;
    }

    // B. Leaflet 무료 지도 (깔끔한 CircleMarker 렌더링)
    if (!window.mapInstance || !window.mapMarkerGroup) return;

    window.mapInstance.invalidateSize();
    window.mapMarkerGroup.clearLayers();
    window.mapInstance.flyTo(targetConfig.center, targetConfig.zoom, { duration: 1.0 });

    chartPoints.forEach(pt => {
        if (!pt.lat || !pt.lng) return;

        // 깔끔한 원형 마커 (글씨 범벅 제거!)
        const marker = L.circleMarker([pt.lat, pt.lng], {
            radius: 8,
            fillColor: pt.quad_color || "#3b82f6",
            color: "#ffffff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9
        });

        // 마우스 호버 시 가벼운 동네 이름만 툴팁 표시
        marker.bindTooltip(`<strong>${pt.region}</strong>`, {
            permanent: false,
            direction: "top"
        });

        // ★ 클릭 시 오른쪽 패널에 상세 정보 즉시 표시!
        marker.on("click", function () {
            displaySelectedDetail(pt);
            
            // 지도 팝업도 함께 가볍게 오픈
            const popupHtml = `
                <div class="popup-mini-box">
                    <strong>${pt.region}</strong>
                    <div>💰 예산: ${formatKoreanCurrency(pt.x)}</div>
                    <div>🚨 범죄: ${pt.y.toFixed(0)}건</div>
                </div>
            `;
            marker.bindPopup(popupHtml, { className: "custom-clean-popup" }).openPopup();
        });

        window.mapMarkerGroup.addLayer(marker);
    });

    // 초기 기본 선택: 첫 번째 동네 자동 표시
    if (chartPoints.length > 0) {
        displaySelectedDetail(chartPoints[0]);
    }
}

/**
 * 3. 클릭한 동네의 상세 정보 패널 업데이트 및 막대그래프 렌더링
 */
function displaySelectedDetail(pt) {
    const placeholder = document.getElementById("detailContentPlaceholder");
    const statsBox = document.getElementById("detailStatsBox");
    const nameEl = document.getElementById("selectedRegionName");
    const badgeEl = document.getElementById("selectedBadge");
    const budgetEl = document.getElementById("dBudgetVal");
    const crimeEl = document.getElementById("dCrimeVal");
    const effEl = document.getElementById("dEffVal");
    const effGradeEl = document.getElementById("dEffGrade");
    const effReasonList = document.getElementById("effReasonList");
    const noteEl = document.getElementById("dNoteVal");
    const commentEl = document.getElementById("dCommentText");
    const barChartTitle = document.getElementById("barChartRegionTitle");

    if (placeholder) placeholder.style.display = "none";
    if (statsBox) statsBox.style.display = "flex";

    if (nameEl) nameEl.textContent = pt.region;
    if (barChartTitle) barChartTitle.textContent = pt.region;
    if (budgetEl) budgetEl.textContent = formatKoreanCurrency(pt.x);
    if (crimeEl) crimeEl.textContent = `${Number(pt.y).toLocaleString()}건`;
    if (noteEl) noteEl.textContent = pt.note || "일반 주거 지역";

    // 안전 효율 점수 계산 (100점 만점 기준)
    const avgX = currentStatsAverages.avgX || 1;
    const avgY = currentStatsAverages.avgY || 1;
    
    // 예산 1억 원당 범죄 발생률
    const in100M = pt.x / 100000000.0;
    const costPerCrime = in100M > 0 ? (pt.y / in100M) : 0;
    const avgCostPerCrime = (avgY / (avgX / 100000000.0));
    
    let effScore = Math.round(100 - ((costPerCrime / (avgCostPerCrime * 1.6)) * 50));
    let gradeLabel = "보통";
    let gradeColor = "#0f766e";

    if (pt.quadrant === "Q4_EFFECTIVE") {
        effScore = Math.min(98, Math.max(82, effScore + 15));
        gradeLabel = "최우수 (A+)";
        gradeColor = "#065f46";
    } else if (pt.quadrant === "Q3_PEACEFUL") {
        effScore = Math.min(88, Math.max(72, effScore + 5));
        gradeLabel = "우수 (A)";
        gradeColor = "#1e40af";
    } else if (pt.quadrant === "Q1_REVERSE") {
        effScore = Math.min(65, Math.max(45, effScore - 5));
        gradeLabel = "주의 (B)";
        gradeColor = "#b45309";
    } else if (pt.quadrant === "Q2_BLINDSPOT") {
        effScore = Math.min(48, Math.max(25, effScore - 15));
        gradeLabel = "개선시급 (C)";
        gradeColor = "#b91c1c";
    }
    
    if (effEl) effEl.textContent = `${effScore}점`;
    if (effGradeEl) {
        effGradeEl.textContent = gradeLabel;
        effGradeEl.style.color = gradeColor;
    }

    // ★ 안전효율 점수 산출 근거 3가지 동적 생성
    if (effReasonList) {
        const budgetRatio = Math.round((pt.x / avgX) * 100);
        const crimeRatio = Math.round((pt.y / avgY) * 100);
        
        let reason1 = `<strong>예산 1억 원당 범죄:</strong> 약 <strong>${costPerCrime.toFixed(1)}건</strong> (평균 ${avgCostPerCrime.toFixed(1)}건 대비 ${costPerCrime <= avgCostPerCrime ? '<span style="color:#16a34a;">우수</span>' : '<span style="color:#dc2626;">취약</span>'})`;
        let reason2 = `<strong>투입 대비 발생 비율:</strong> 예산은 평균의 <strong>${budgetRatio}%</strong>를 썼고, 범죄는 평균의 <strong>${crimeRatio}%</strong> 발생`;
        let reason3 = "";
        
        if (effScore >= 80) {
            reason3 = `<strong>종합 판정:</strong> 적은 비용으로 범죄를 효과적으로 막아내어 <strong>안전 가성비가 매우 높음</strong>`;
        } else if (effScore >= 65) {
            reason3 = `<strong>종합 판정:</strong> 조용한 주거 환경으로 치안 상태가 안정적으로 유지 중`;
        } else if (effScore >= 45) {
            reason3 = `<strong>종합 판정:</strong> 번화가/유흥가 밀집으로 <strong>많은 예산 투입에도 사건이 잦아 효율 감점</strong>`;
        } else {
            reason3 = `<strong>종합 판정:</strong> 범죄는 많은데 예산이 턱없이 부족하여 <strong>긴급 예산 수혈 필요</strong>`;
        }

        effReasonList.innerHTML = `
            <li>${reason1}</li>
            <li>${reason2}</li>
            <li>${reason3}</li>
        `;
    }

    // 4사분면 뱃지 및 진단 코멘트
    let badgeClass = "badge-q4";
    let comment = "예산을 알차게 투입하여 범죄를 억제하는 데 성공한 1등 안심 모범 지역입니다.";

    if (pt.quadrant === "Q1_REVERSE") {
        badgeClass = "badge-q1";
        comment = "유동인구와 번화가가 많아 사건사고가 잦으며, 구청과 경찰이 예산을 가장 집중적으로 쏟아붓고 있는 곳입니다.";
    } else if (pt.quadrant === "Q2_BLINDSPOT") {
        badgeClass = "badge-q2";
        comment = "범죄 발생이 높은 편이나 예산이 부족합니다. 차년도 방범 인프라 긴급 지원이 가장 시급한 지역입니다.";
    } else if (pt.quadrant === "Q3_PEACEFUL") {
        badgeClass = "badge-q3";
        comment = "조용한 주거지 위주로 구성되어 있어, 큰 예산 투입 없이도 스스로 평온하고 안전한 치안을 유지하고 있습니다.";
    }

    if (badgeEl) {
        badgeEl.className = `detail-badge ${badgeClass}`;
        badgeEl.textContent = pt.quad_label;
    }
    if (commentEl) {
        commentEl.textContent = comment;
    }

    // ★ 클릭한 동네의 핵심 지표 3가지 막대그래프 즉시 렌더링!
    renderDetailBarChart(pt, effScore);
}

/**
 * 4. 클릭한 동네의 [총 예산, 범죄발생건수, 예산대비 안전효율] 막대그래프 렌더링
 */
function renderDetailBarChart(pt, effScore) {
    const canvas = document.getElementById("detailBarChart");
    if (!canvas) return;

    if (window.detailBarChartInstance) {
        window.detailBarChartInstance.destroy();
        window.detailBarChartInstance = null;
    }

    const avgX = currentStatsAverages.avgX || 1;
    const avgY = currentStatsAverages.avgY || 1;

    // 평균을 100%로 환산한 상대 지수 계산
    const budgetRatio = Math.round((pt.x / avgX) * 100);
    const crimeRatio = Math.round((pt.y / avgY) * 100);

    const ctx = canvas.getContext("2d");

    window.detailBarChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: ["총 예산", "범죄 발생", "안전 효율"],
            datasets: [{
                data: [budgetRatio, crimeRatio, effScore],
                backgroundColor: [
                    "rgba(59, 130, 246, 0.85)", // 예산: 블루
                    "rgba(239, 68, 68, 0.85)",  // 범죄: 레드
                    "rgba(16, 185, 129, 0.85)"  // 안전효율: 에메랄드 그린
                ],
                borderColor: ["#2563eb", "#dc2626", "#059669"],
                borderWidth: 1.5,
                borderRadius: 4,
                barThickness: 16
            }]
        },
        options: {
            indexAxis: "y", // 가로 막대그래프 (한눈에 쏙 들어옴)
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "rgba(15, 23, 42, 0.95)",
                    padding: 10,
                    callbacks: {
                        label: function (context) {
                            const idx = context.dataIndex;
                            if (idx === 0) {
                                return ` 총 예산: ${formatKoreanCurrency(pt.x)} (평균 대비 ${budgetRatio}%)`;
                            } else if (idx === 1) {
                                return ` 범죄 발생: ${Number(pt.y).toLocaleString()}건 (평균 대비 ${crimeRatio}%)`;
                            } else {
                                return ` 예산대비 안전효율: ${effScore}점 / 100점`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    max: Math.max(160, budgetRatio + 20, crimeRatio + 20),
                    grid: { color: "#f1f5f9" },
                    ticks: {
                        callback: val => val + "%",
                        font: { size: 10 },
                        color: "#64748b"
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: {
                        font: { size: 11, weight: "bold" },
                        color: "#334155"
                    }
                }
            }
        }
    });
}

/**
 * 4. 분석 실행 (/generate)
 */
async function runAnalysis() {
    const selectSido = document.getElementById("selectSido");
    const selectedSido = selectSido ? selectSido.value : "ALL";
    const reportViewer = document.getElementById("reportViewer");
    const targetRegionSpan = document.getElementById("verdictTargetRegion");

    const sidoNames = {
        "ALL": "전국", "서울": "서울특별시", "경기": "경기도", "부산": "부산광역시",
        "대구": "대구광역시", "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시",
        "울산": "울산광역시", "세종": "세종시", "강원": "강원도", "충북": "충청북도",
        "충남": "충청남도", "전북": "전라북도", "전남": "전라남도", "경북": "경상북도",
        "경남": "경상남도", "제주": "제주도"
    };

    if (targetRegionSpan) {
        targetRegionSpan.textContent = sidoNames[selectedSido] || selectedSido;
    }

    try {
        const response = await fetch("/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "A",
                control_type: "total",
                selected_sido: selectedSido,
                exclude_commercial: false
            })
        });

        const resData = await response.json();
        if (!resData.success) {
            showToast(resData.error, "error");
            return;
        }

        updateHypothesisUI(resData.stats, resData.target_region_label);
        currentStatsAverages = {
            avgX: resData.stats.x_mean || 1,
            avgY: resData.stats.y_mean || 1
        };
        renderMapMarkers(resData.chart_data, resData.selected_sido);
        renderMiniChart(resData.chart_data);

        currentGeneratedMarkdown = resData.report_markdown;
        if (reportViewer && typeof marked !== "undefined") {
            reportViewer.innerHTML = marked.parse(currentGeneratedMarkdown);
        }

    } catch (err) {
        console.error("분석 에러:", err);
    }
}

function updateHypothesisUI(stats, regionLabel) {
    const verdictBanner = document.getElementById("verdictBanner");
    const verdictTitle = document.getElementById("verdictTitle");
    const verdictDesc = document.getElementById("verdictDesc");
    const valR = document.getElementById("valCorrelationR");
    const valRDesc = document.getElementById("valCorrelationRDesc");
    const valModelCount = document.getElementById("valModelCount");

    if (verdictTitle) verdictTitle.textContent = stats.hypothesis_verdict;
    if (verdictDesc) {
        if (stats.r > 0) {
            verdictDesc.textContent = `${regionLabel} ${stats.sample_count}개 동네: 불이 많이 나는 곳에 소방관이 가듯, 번화가에 예산이 집중되어 '예산 많음 = 사건 많음'으로 관측됩니다.`;
        } else {
            verdictDesc.textContent = `${regionLabel} ${stats.sample_count}개 동네: 예산을 많이 쓴 동네일수록 범죄 예방 시설이 잘 갖춰져 범죄가 줄어들고 있습니다.`;
        }
    }

    if (verdictBanner) {
        verdictBanner.className = "verdict-banner card verdict-" + (stats.verdict_badge || "warning");
    }

    if (valR) {
        if (stats.r > 0.15) {
            valR.textContent = "예산 많은 곳 = 범죄도 많음";
            valR.style.color = "#b45309";
        } else if (stats.r < -0.15) {
            valR.textContent = "예산 많을수록 = 범죄 줄어듦";
            valR.style.color = "#047857";
        } else {
            valR.textContent = "예산과 범죄 = 서로 무관함";
            valR.style.color = "#475569";
        }
    }
    if (valRDesc) {
        const sign = stats.r >= 0 ? "+" : "";
        valRDesc.textContent = `통계 수치: ${sign}${stats.r.toFixed(2)} (위험 지역 예산 집중)`;
    }

    const q = stats.quadrants || {};
    const q4Count = q.q4_effective ? q.q4_effective.length : 0;
    if (valModelCount) valModelCount.textContent = `${q4Count}개 동네`;
}

function renderMiniChart(chartPoints) {
    const canvas = document.getElementById("correlationChart");
    if (!canvas) return;

    if (window.correlationChartInstance) {
        window.correlationChartInstance.destroy();
        window.correlationChartInstance = null;
    }

    const ctx = canvas.getContext("2d");
    const pointColors = chartPoints.map(p => p.quad_color || "#2563eb");

    window.correlationChartInstance = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [{
                data: chartPoints,
                backgroundColor: pointColors,
                pointRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    ticks: {
                        callback: val => formatKoreanCurrency(val)
                    }
                },
                y: {
                    ticks: {
                        callback: val => val + "건"
                    }
                }
            }
        }
    });
}

function copyReportToClipboard() {
    if (!currentGeneratedMarkdown) return;
    navigator.clipboard.writeText(currentGeneratedMarkdown).then(() => {
        showToast("핵심 요약이 복사되었습니다!", "success");
    });
}

/**
 * 5. 사용자 맞춤 자유 질문 전송 및 AI 답변 렌더링
 */
async function sendUserQuestion() {
    const input = document.getElementById("userQuestionInput");
    const container = document.getElementById("qaAnswerContainer");
    const loading = document.getElementById("qaLoading");
    const bubble = document.getElementById("qaAnswerBubble");
    const selectSido = document.getElementById("selectSido");
    const selectedSido = selectSido ? selectSido.value : "전국";

    if (!input || !input.value.trim()) {
        showToast("궁금한 질문을 입력해주세요!", "info");
        return;
    }

    const questionText = input.value.trim();

    if (container) container.style.display = "block";
    if (loading) loading.style.display = "flex";
    if (bubble) bubble.innerHTML = "";

    try {
        const response = await fetch("/ask-ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                question: questionText,
                selected_region: selectedSido
            })
        });

        const resData = await response.json();
        if (!resData.success) {
            if (bubble) bubble.innerHTML = `<p style="color:#dc2626;">오류가 발생했습니다: ${resData.error}</p>`;
            return;
        }

        if (bubble) {
            if (typeof marked !== "undefined") {
                bubble.innerHTML = marked.parse(resData.answer);
            } else {
                bubble.innerText = resData.answer;
            }
        }

        showToast("인공지능 답변이 도착했습니다!", "success");

    } catch (err) {
        console.error("질문 전송 에러:", err);
        if (bubble) bubble.innerHTML = `<p style="color:#dc2626;">서버와 통신 중 문제가 발생했습니다.</p>`;
    } finally {
        if (loading) loading.style.display = "none";
    }
}

function showToast(message, type = "info") {
    const toast = document.getElementById("toastMessage");
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === "error" ? "#dc2626" : (type === "success" ? "#16a34a" : "#0f172a");
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 2800);
}
