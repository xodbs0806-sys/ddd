/**
 * AI Crime Budget & Rate - Permanent Visible Map & Dashboard Script
 * 클릭 없이 지도 위에 바로 동네 상태와 예산 라벨 상시 노출
 */

window.mapInstance = null;
window.mapMarkerGroup = null;
window.kakaoMapInstance = null;
window.kakaoOverlayList = [];
window.correlationChartInstance = null;
let currentRawData = null;
let currentGeneratedMarkdown = "";

// 각 시·도별 중심 위경도 및 권장 줌 레벨
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
 * 1. 지도 초기화 (카카오 키가 있으면 카카오 지도, 없으면 무료 Leaflet 자동 선택)
 */
function initMap() {
    const mapEl = document.getElementById("crimeMap");
    if (!mapEl) return;

    if (window.kakao && window.kakao.maps) {
        // 카카오 지도 SDK 비동기 준비 콜백
        kakao.maps.load(function () {
            const options = {
                center: new kakao.maps.LatLng(36.2, 127.8),
                level: 13
            };
            window.kakaoMapInstance = new kakao.maps.Map(mapEl, options);
            console.log("Kakao Maps 정식 활성화 완료");
            
            // 데이터가 이미 로드되어 있다면 마커 즉시 렌더링
            if (window.pendingChartPoints) {
                renderMapMarkers(window.pendingChartPoints, window.pendingSido || "ALL");
            }
        });
    } else {
        // 기본 무료 Leaflet 지도 활성화
        if (window.mapInstance) return;
        window.mapInstance = L.map("crimeMap", {
            center: [36.2, 127.8],
            zoom: 7,
            zoomControl: true
        });

        L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            subdomains: "abcd",
            maxZoom: 19
        }).addTo(window.mapInstance);

        window.mapMarkerGroup = L.layerGroup().addTo(window.mapInstance);
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
        return `${sign}${formatted}억`;
    } else if (absVal >= 10000) {
        const in10K = Math.round(absVal / 10000);
        return `${sign}${in10K.toLocaleString()}만`;
    } else {
        return `${sign}${Math.round(absVal).toLocaleString()}원`;
    }
}

/**
 * 엑셀 데이터 로드
 */
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
        showToast("데이터를 읽어오는 중 문제가 발생했습니다.", "error");
    }
}

/**
 * 2. 지도 위에 클릭 없이 바로 보이는 '상시 라벨' 렌더링 (하이브리드 지원)
 */
function renderMapMarkers(chartPoints, selectedSido) {
    window.pendingChartPoints = chartPoints;
    window.pendingSido = selectedSido;
    const targetConfig = SIDO_COORDINATES[selectedSido] || SIDO_COORDINATES["ALL"];

    // A. 카카오 지도 지원
    if (window.kakaoMapInstance) {
        // 기존 오버레이 삭제
        if (window.kakaoOverlayList) {
            window.kakaoOverlayList.forEach(ov => ov.setMap(null));
        }
        window.kakaoOverlayList = [];

        // 시도 중심 이동 및 줌 레벨 조정
        const moveLatLon = new kakao.maps.LatLng(targetConfig.center[0], targetConfig.center[1]);
        window.kakaoMapInstance.setCenter(moveLatLon);
        window.kakaoMapInstance.setLevel(targetConfig.kakaoLevel || 10);

        chartPoints.forEach(pt => {
            if (!pt.lat || !pt.lng) return;

            let shortName = pt.region;
            const prefixes = ["서울 ", "부산 ", "대구 ", "인천 ", "광주 ", "대전 ", "울산 ", "경기도 ", "강원도 ", "충북 ", "충남 ", "전북 ", "전남 ", "경북 ", "경남 ", "제주 "];
            prefixes.forEach(p => { if (shortName.startsWith(p)) shortName = shortName.replace(p, ""); });

            const formattedBudget = formatKoreanCurrency(pt.x);

            let badgeClass = "badge-chip-q4";
            let shortTag = "안심";
            if (pt.quadrant === "Q1_REVERSE") { badgeClass = "badge-chip-q1"; shortTag = "번화가"; }
            else if (pt.quadrant === "Q2_BLINDSPOT") { badgeClass = "badge-chip-q2"; shortTag = "지원시급"; }
            else if (pt.quadrant === "Q3_PEACEFUL") { badgeClass = "badge-chip-q3"; shortTag = "평온"; }

            const contentHtml = document.createElement("div");
            contentHtml.className = `map-badge-chip ${badgeClass}`;
            contentHtml.innerHTML = `<span>${shortName}</span> <span style="opacity:0.9; font-weight:normal;">${formattedBudget}</span> <span class="badge-tag-mini">${shortTag}</span>`;

            const position = new kakao.maps.LatLng(pt.lat, pt.lng);
            const customOverlay = new kakao.maps.CustomOverlay({
                position: position,
                content: contentHtml,
                yAnchor: 0.5
            });

            customOverlay.setMap(window.kakaoMapInstance);
            window.kakaoOverlayList.push(customOverlay);
        });

        return;
    }

    // B. Leaflet 무료 지도 지원
    if (!window.mapInstance || !window.mapMarkerGroup) return;

    window.mapMarkerGroup.clearLayers();
    window.mapInstance.flyTo(targetConfig.center, targetConfig.zoom, { duration: 1.0 });

    chartPoints.forEach(pt => {
        if (!pt.lat || !pt.lng) return;

        let shortName = pt.region;
        const prefixes = ["서울 ", "부산 ", "대구 ", "인천 ", "광주 ", "대전 ", "울산 ", "경기도 ", "강원도 ", "충북 ", "충남 ", "전북 ", "전남 ", "경북 ", "경남 ", "제주 "];
        prefixes.forEach(p => {
            if (shortName.startsWith(p)) shortName = shortName.replace(p, "");
        });

        const formattedBudget = formatKoreanCurrency(pt.x);

        let badgeClass = "badge-chip-q4";
        let shortTag = "안심";
        if (pt.quadrant === "Q1_REVERSE") {
            badgeClass = "badge-chip-q1";
            shortTag = "번화가";
        } else if (pt.quadrant === "Q2_BLINDSPOT") {
            badgeClass = "badge-chip-q2";
            shortTag = "지원시급";
        } else if (pt.quadrant === "Q3_PEACEFUL") {
            badgeClass = "badge-chip-q3";
            shortTag = "평온";
        }

        const labelHtml = `
            <div class="map-badge-chip ${badgeClass}">
                <span>${shortName}</span>
                <span style="opacity:0.9; font-weight:normal;">${formattedBudget}</span>
                <span class="badge-tag-mini">${shortTag}</span>
            </div>
        `;

        const marker = L.circleMarker([pt.lat, pt.lng], {
            radius: 1,
            opacity: 0,
            fillOpacity: 0
        });

        marker.bindTooltip(labelHtml, {
            permanent: true,
            direction: "center",
            className: "custom-map-label"
        });

        window.mapMarkerGroup.addLayer(marker);
    });
}

/**
 * 3. 분석 실행 (/generate)
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

        // 상단 배너 업데이트
        updateHypothesisUI(resData.stats, resData.target_region_label);

        // ★ 지도 위에 상시 라벨 렌더링
        renderMapMarkers(resData.chart_data, resData.selected_sido);

        // 미니 흐름 그래프 렌더링
        renderMiniChart(resData.chart_data);

        // 3줄 AI 브리핑 업데이트
        currentGeneratedMarkdown = resData.report_markdown;
        if (reportViewer && typeof marked !== "undefined") {
            reportViewer.innerHTML = marked.parse(currentGeneratedMarkdown);
        }

    } catch (err) {
        console.error("분석 에러:", err);
    }
}

/**
 * 상단 간결 배너 업데이트
 */
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
        valR.textContent = (stats.r >= 0 ? "+" : "") + stats.r.toFixed(2);
        valR.style.color = stats.r >= 0 ? "#b45309" : "#047857";
    }
    if (valRDesc) {
        valRDesc.textContent = stats.r > 0 ? "예산 많을수록 범죄도 많음" : "예산 많을수록 범죄 줄어듦";
    }

    const q = stats.quadrants || {};
    const q4Count = q.q4_effective ? q.q4_effective.length : 0;
    if (valModelCount) valModelCount.textContent = `${q4Count}개 동네`;
}

/**
 * 미니 흐름 그래프 렌더링 (보조)
 */
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

function showToast(message, type = "info") {
    const toast = document.getElementById("toastMessage");
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === "error" ? "#dc2626" : (type === "success" ? "#16a34a" : "#0f172a");
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 2800);
}
