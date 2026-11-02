// WebRTC Yapılandırması (STUN sunucuları)
const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let peerConnection;
let dataChannel;
let isInitiator = false;
let currentFile = null;
let receivedBuffers = [];
let receivedSize = 0;
let fileSize = 0;
let fileName = "";

// UI Elementleri
const setupSection = document.getElementById('setup-section');
const transferSection = document.getElementById('transfer-section');
const btnCreateOffer = document.getElementById('btn-create-offer');
const btnScanQR = document.getElementById('btn-scan-qr');
const qrContainer = document.getElementById('qr-container');
const qrReader = document.getElementById('qr-reader');
const chatBox = document.getElementById('chat-box');
const progressBar = document.getElementById('progress-bar');
const previewArea = document.getElementById('preview-area');

// --- 1. Bağlantı Kurma (Masaüstü: QR Oluştur) ---
btnCreateOffer.addEventListener('click', async () => {
    isInitiator = true;
    initPeerConnection();
    
    // DataChannel oluştur (Masaüstü tarafı)
    dataChannel = peerConnection.createDataChannel('fileTransfer');
    setupDataChannel();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // ICE adaylarının toplanmasını bekle ve QR koda yaz
    peerConnection.onicecandidate = (event) => {
        if (event.candidate === null) {
            // SDP hazır, QR kod oluştur
            const offerData = btoa(JSON.stringify(peerConnection.localDescription));
            qrContainer.classList.remove('hidden');
            new QRCode(document.getElementById("qrcode"), {
                text: offerData,
                width: 256,
                height: 256
            });
        }
    };
});

// --- 2. Bağlantı Kurma (Mobil: QR Tara) ---
btnScanQR.addEventListener('click', async () => {
    isInitiator = false;
    qrReader.classList.remove('hidden');
    
    const html5QrCode = new Html5Qrcode("qr-reader");
    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
            // QR okundu, bağlantıyı başlat
            await html5QrCode.stop();
            qrReader.classList.add('hidden');
            
            initPeerConnection();
            
            // Karşı tarafın teklifini (offer) ayarla
            const offer = JSON.parse(atob(decodedText));
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            
            // Cevap (answer) oluştur
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            // Mobil taraf cevabı QR olarak göstermeli (Basitlik için konsola yazdırıyoruz, gerçekte QR gösterilmeli)
            // NOT: Tam P2P için Masaüstü bu cevabı okumalıdır. (Şimdilik akışı tamamlamak için manuel)
            console.log("Mobil Cevabı (Masaüstüne okutulmalı):", btoa(JSON.stringify(peerConnection.localDescription)));
            
            // Mobil taraf DataChannel dinleyicisi
            peerConnection.ondatachannel = (event) => {
                dataChannel = event.channel;
                setupDataChannel();
            };
        }
    );
});

// WebRTC Başlatıcı
function initPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            setupSection.classList.add('hidden');
            transferSection.classList.remove('hidden');
        }
    };
}

// --- 3. DataChannel ve Transfer Mantığı ---
function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
        console.log("DataChannel Açıldı");
        setupSection.classList.add('hidden');
        transferSection.classList.remove('hidden');
    };

    dataChannel.onmessage = (event) => {
        const data = event.data;
        
        // Eğer veri string ise (Sohbet mesajı)
        if (typeof data === 'string') {
            try {
                const meta = JSON.parse(data);
                if (meta.type === 'file-start') {
                    fileName = meta.name;
                    fileSize = meta.size;
                    receivedBuffers = [];
                    receivedSize = 0;
                    progressBar.style.width = '0%';
                    progressBar.innerText = '0%';
                } else if (meta.type === 'file-end') {
                    const blob = new Blob(receivedBuffers);
                    showPreview(blob, fileName);
                    receivedBuffers = [];
                }
            } catch (e) {
                // Normal metin mesajı
                appendMessage(data, 'msg-other');
            }
        } 
        // Eğer veri ArrayBuffer ise (Dosya parçası - Chunk)
        else if (data instanceof ArrayBuffer) {
            receivedBuffers.push(data);
            receivedSize += data.byteLength;
            const percent = Math.floor((receivedSize / fileSize) * 100);
            progressBar.style.width = percent + '%';
            progressBar.innerText = percent + '%';
        }
    };
}

// Sohbet Gönderme
document.getElementById('btn-send-msg').addEventListener('click', () => {
    const input = document.getElementById('chat-input');
    if (input.value && dataChannel.readyState === 'open') {
        dataChannel.send(input.value);
        appendMessage(input.value, 'msg-self');
        input.value = '';
    }
});

function appendMessage(msg, className) {
    const div = document.createElement('div');
    div.className = `message ${className}`;
    div.innerText = msg;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// --- 4. Dosya Transferi (Chunking) ---
document.getElementById('btn-send-file').addEventListener('click', () => {
    const file = document.getElementById('file-input').files[0];
    if (!file || dataChannel.readyState !== 'open') return;

    const CHUNK_SIZE = 16384; // 16KB (Güvenli WebRTC sınırı)
    let offset = 0;

    // Meta veriyi gönder
    dataChannel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size }));

    const reader = new FileReader();
    
    reader.onload = (e) => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        
        const percent = Math.floor((offset / file.size) * 100);
        progressBar.style.width = percent + '%';
        progressBar.innerText = percent + '%';

        if (offset < file.size) {
            readSlice(offset);
        } else {
            dataChannel.send(JSON.stringify({ type: 'file-end' }));
            progressBar.innerText = 'Tamamlandı!';
        }
    };

    const readSlice = (o) => {
        const slice = file.slice(offset, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
});

// --- 5. Ön İzleme ve İndirme ---
function showPreview(blob, name) {
    previewArea.innerHTML = ''; // Temizle
    const url = URL.createObjectURL(blob);
    const ext = name.split('.').pop().toLowerCase();
    
    if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) {
        const img = document.createElement('img');
        img.src = url;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '300px';
        previewArea.appendChild(img);
    } else if (['mp4', 'webm'].includes(ext)) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.style.maxWidth = '100%';
        previewArea.appendChild(video);
    }
    
    // İndirme Butonu
    const downloadBtn = document.createElement('a');
    downloadBtn.href = url;
    downloadBtn.download = name;
    downloadBtn.innerText = "Cihaza İndir";
    downloadBtn.style.display = 'block';
    downloadBtn.style.marginTop = '10px';
    downloadBtn.className = 'button';
    previewArea.appendChild(downloadBtn);
}