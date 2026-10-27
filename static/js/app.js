/**
 * AI Crime Budget & Rate - Clean Interactive Map & Click-to-View Detail
 * 지도 위의 복잡한 글자들을 걷어내고, 궁금한 동네 클릭 시 상세 정보 즉시 표시
 */

window.mapInstance = null;
window.mapMarkerGroup = null;
window.kakaoMapInstance = null;
window.kakaoMarkerList = [];
window.correlationChartInstance = null;
let currentRawData = null;
let currentGeneratedMarkdown = "";

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
 * 1. 지도 초기화 (카카오 키 정상이면 카카오 지도, 오류 시 무료 Leaflet 자동 폴백)
 */
function initMap() {
    const mapEl = document.getElementById("crimeMap");
    if (!mapEl) return;

    if (!window.KAKAO_LOAD_FAILED && window.kakao && window.kakao.maps) {
        try {
            kakao.maps.load(function () {
                try {
                    const options = {
                        center: new kakao.maps.LatLng(36.2, 127.8),
                        level: 13
                    };
                    window.kakaoMapInstance = new kakao.maps.Map(mapEl, options);
                    console.log("Kakao Maps 정식 활성화 완료");
                    if (window.pendingChartPoints) {
                        renderMapMarkers(window.pendingChartPoints, window.pendingSido || "ALL");
                    }
                } catch (mapErr) {
                    fallbackToLeaflet();
                }
            });
        } catch (sdkErr) {
            fallbackToLeaflet();
        }

        setTimeout(function () {
            if (!window.kakaoMapInstance && !window.mapInstance) {
                fallbackToLeaflet();
            }
        }, 1500);

    } else {
        fallbackToLeaflet();
    }
}

function fallbackToLeaflet() {
    const mapEl = document.getElementById("crimeMap");
    if (!mapEl || window.mapInstance) return;

    window.kakaoMapInstance = null;
    mapEl.innerHTML = "";

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
 * 3. 클릭한 동네의 상세 정보 패널 업데이트
 */
function displaySelectedDetail(pt) {
    const placeholder = document.getElementById("detailContentPlaceholder");
    const statsBox = document.getElementById("detailStatsBox");
    const nameEl = document.getElementById("selectedRegionName");
    const badgeEl = document.getElementById("selectedBadge");
    const budgetEl = document.getElementById("dBudgetVal");
    const crimeEl = document.getElementById("dCrimeVal");
    const popEl = document.getElementById("dPopVal");
    const noteEl = document.getElementById("dNoteVal");
    const commentEl = document.getElementById("dCommentText");

    if (placeholder) placeholder.style.display = "none";
    if (statsBox) statsBox.style.display = "flex";

    if (nameEl) nameEl.textContent = pt.region;
    if (budgetEl) budgetEl.textContent = formatKoreanCurrency(pt.x);
    if (crimeEl) crimeEl.textContent = `${Number(pt.y).toLocaleString()}건`;
    if (popEl) popEl.textContent = pt.pop ? `${Number(pt.pop).toLocaleString()}명` : "-";
    if (noteEl) noteEl.textContent = pt.note || "일반 주거 지역";

    // 4사분면 뱃지 및 진단 코멘트
    let badgeClass = "badge-q4";
    let comment = "예산을 알차게 투입하여 범죄를 억제하는 데 성공한 모범 지역입니다.";

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
