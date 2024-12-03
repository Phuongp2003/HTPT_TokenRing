const net = require('net');
const os = require('os');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const WebSocket = require('ws');

let machineIp = getLocalIpAddress();
let machinePort = 3000;
let nextMachineIpPort = '';
let hasToken = false;
let inReconnecting = false;
let heartbeatInterval;
let heartbeatTimeout;

// Interface server
const app = express();

// Port in init with args
const args = process.argv.slice(2);
const initialPort = args[0]
    ? parseInt(args[0], 10)
    : process.env.PORT
        ? parseInt(process.env.PORT, 10)
        : 3000;

startServer(initialPort);

// Interface - Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json());

// Interface - Render
app.get('/', (req, res) => {
    res.render('index', { machineIp, machinePort, nextMachineIpPort, hasToken, inReconnecting });
});

app.post('/send-token', (req, res) => {
    sendTokenToNextMachine();
    res.send('Đã gửi token cho máy tiếp theo!');
});

app.post('/join-ring', (req, res) => {
    const { ipPort } = req.body;
    joinRing(ipPort);
    res.send('Đã gửi lệnh tham gia vòng!');
});

app.post('/exit-ring', (req, res) => {
    exitRing();
    res.send('Đã thoát vòng!');
});

// WebSocket server for realtime update
const server = app.listen(initialPort, () => {
    cLog(`Interface server running at http://localhost:${initialPort}`);
    startHeartbeat();
});
const wss = new WebSocket.Server({ server });

// Setup function
function cLog(...message) {
    console.log(new Date().toLocaleTimeString(), ...message);
    sendLogToClient(message);
}

function cError(...message) {
    console.error(new Date().toLocaleTimeString(), ...message);
    sendLogToClient(message, 'error');
}

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless') || name.toLowerCase().includes('wlan')) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    }
    return 'localhost';
}

function startServer(port) {
    try {
        const server = net.createServer(handleConnection);
        server.listen(port, machineIp, () => {
            machinePort = port;
            cLog(`Máy ${machineIp}:${machinePort} đang chạy...`);
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                cLog(`Cổng ${port} đang bận, thử cổng khác...`);
                startServer(port + 1);
            } else {
                cError('Lỗi khi khởi động server:', err.message);
            }
        });
    } catch (error) {
        cError(error);
    }
}
// Event controller
function handleConnection(socket) {
    try {
        socket.on('data', (data) => {
            let message = data.toString();
            cLog("Tin nhắn: ", message)
            if (message === 'TOKEN') {
                handleToken(socket);
            } else if (message.startsWith('NEXT')) {
                handleNext(socket, message);
            } else if (message.startsWith('JOIN_REQUEST')) {
                handleJoinRequest(socket, message);
            } else if (message.startsWith('JOIN')) {
                handleJoin(socket, message);
            } else if (message.startsWith('HEARTBEAT')) {
                resetHeartbeatTimeout();
            } else if (message.startsWith('EXIT')) {
                handleExit(socket, message);
            } else if (message.startsWith('RECONNECT')) {
                handleReconnect(message)
            }
        });
        socket.on('error', (err) => cError(err));
        broadcastUpdate();
    } catch (error) {
        cError(error);
    }
}

// Handle event
// Token
function handleToken(socket) {
    try {
        cLog(`Máy ${machineIp}:${machinePort} nhận được token.`);
        hasToken = true;
        broadcastUpdate();
    } catch (error) {
        cError(error);
    }
}

function sendTokenToNextMachine() {
    try {
        if (nextMachineIpPort) {
            const [nextIp, nextPort] = nextMachineIpPort.split(':');
            const client = new net.Socket();
            client.connect(nextPort, nextIp, () => {
                client.write('TOKEN');
                client.end();
            });
            hasToken = false; // Cập nhật trạng thái token
            broadcastUpdate(); // Cập nhật trạng thái token

            client.on('error', (err) => {
                cError('Không thể gửi token đến máy tiếp theo, chi tiết: ', err.message);
                // Nếu không thể kết nối tới máy kế tiếp, điều chỉnh vòng để bỏ qua máy đó
                nextMachineIpPort = '';
                hasToken = true;
                broadcastUpdate();
            });
        } else {
            cError('Không có thông tin máy kế tiếp.');
        }
    } catch (error) {
        cError(error);
    }
}

// Setup next machine
function handleNext(socket, message) {
    try {
        nextMachineIpPort = message.split(' ')[1];
        cLog(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
    } catch (error) {
        cError(error);
    }
}

// Join event
function handleJoinRequest(socket, message) {
    try {
        const parts = message.split(' ');
        const newMachineIpPort = parts[1];
        const requesterIpPort = parts[2];
        const [newMachineIp, newMachinePort] = newMachineIpPort.split(':');
        const [requesterIp, requesterPort] = requesterIpPort.split(':');

        if (nextMachineIpPort === `${requesterIp}:${requesterPort}`) {
            const oldNextMachineIpPort = nextMachineIpPort;
            nextMachineIpPort = `${newMachineIp}:${newMachinePort}`;

            const client = new net.Socket();
            client.connect(parseInt(newMachinePort, 10), newMachineIp, () => {
                client.write(`NEXT ${oldNextMachineIpPort}`);
                client.end();
            });
            broadcastUpdate();
            cLog(`Máy mới (${newMachineIp}:${newMachinePort}) đã gia nhập ngay sau ${machineIp}:${machinePort}.`);
        } else {
            const client = new net.Socket();
            client.connect(nextMachineIpPort.split(':')[1], nextMachineIpPort.split(':')[0], () => {
                client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${requesterIp}:${requesterPort}`);
                client.end();
            });
            cLog(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được chuyển tiếp.`);
        }
    } catch (error) {
        cError(error);
    }
}

function handleJoin(socket, message) {
    try {
        const [newMachineIp, newMachinePort] = message.split(' ')[1].split(':');
        if (newMachineIp === machineIp && newMachinePort === String(machinePort)) {
            return;
        }

        const client = new net.Socket();
        client.connect(parseInt(nextMachineIpPort.split(':')[1], 10), nextMachineIpPort.split(':')[0], () => {
            client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${machineIp}:${machinePort}`);
            client.end();
        });

        cLog(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được gửi.`);
    } catch (error) {
        cError(error);
    }
}

function joinRing(ipPort) {
    try {
        if (ipPort && ipPort !== `${machineIp}:${machinePort}`) {
            const [inputIp, inputPort] = ipPort.split(':');
            nextMachineIpPort = `${inputIp}:${inputPort}`;
            const client = new net.Socket();
            client.connect(parseInt(inputPort, 10), inputIp, () => {
                cLog(`Máy ${inputIp}:${inputPort} đã kết nối, tiến hành kết nối với máy ${nextMachineIpPort} để tham gia vòng!`);
                client.write(`JOIN ${machineIp}:${machinePort}`);
                client.end();
            });
        } else {
            nextMachineIpPort = `${machineIp}:${machinePort}`;
            hasToken = true;
            cLog('Máy này là máy đầu tiên trong vòng.');
            sendTokenToNextMachine();
        }
        broadcastUpdate();
    } catch (error) {
        cError(error);
    }
}

// Heart beat - Self-healing
function startHeartbeat() {
    try {
        heartbeatInterval = setInterval(() => {
            if (nextMachineIpPort) {
                const [nextIp, nextPort] = nextMachineIpPort.split(':');
                const client = new net.Socket();
                client.connect(nextPort, nextIp, () => {
                    client.write(`HEARTBEAT`);
                    client.end();
                });

                client.on('error', (err) => {
                    cError('Không thể gửi heartbeat đến máy sau đó, vào trạng thái chờ kết nói lại! Chi tiết: ', err.message);
                    clearInterval(heartbeatInterval)
                });
            }
        }, 5000);
    } catch (error) {
        cError(error);
    }
}

function resetHeartbeatTimeout() {
    try {
        clearTimeout(heartbeatTimeout);
        createHeartbeatTimeout();
        cLog(`Đã tạo lại heartbeat!`);
    } catch (error) {
        cError(error);
    }
}

function createHeartbeatTimeout() {
    const client = new net.Socket();
    const [nextIp, nextPort] = nextMachineIpPort.split(':');
    inReconnecting = false;
    cLog(`Reset timeout!`);
    heartbeatTimeout = setTimeout(() => {
        cError('Không nhận lại được tin nhẵn đã gửi!');
        clearTimeout(heartbeatTimeout);
        client.connect(nextPort, nextIp, () => {
            client.write(`RECONNECT ${machineIp}:${machinePort} ${hasToken ? 'HTOKEN' : 'NTOKEN'}`);
            cLog('Gửi y/c kết nối thành công!')
            inReconnecting = true;
            client.end();
        });

        client.on('error', (err) => {
            cError('Không thể gửi yêu cầu reconnect đến máy tiếp theo, tiến hành huỷ vòng! Chi tiết: ', err.message);
            clearInterval(heartbeatInterval)
            clearTimeout(heartbeatTimeout)
            nextMachineIpPort = ''
            hasToken = false;
            broadcastUpdate();
        });
    }, 10000);
}

// Exit ring event
function exitRing() {
    try {
        if (!nextMachineIpPort) {
            cError("Không có máy tiếp theo để thông báo thoát.");
            return;
        }

        const exitMessage = `EXIT ${machineIp}:${machinePort} ${nextMachineIpPort}`;
        const [nextIp, nextPort] = nextMachineIpPort.split(':');
        const client = new net.Socket();

        if (hasToken) {
            sendTokenToNextMachine();
        }

        client.connect(nextPort, nextIp, () => {
            cLog(`Thông báo thoát khỏi vòng được gửi!`);
            client.write(exitMessage);
            client.end();
        });

        nextMachineIpPort = ''
        clearInterval(heartbeatInterval);
        clearTimeout(heartbeatTimeout);
        broadcastUpdate();

        client.on('error', (err) => {
            cError("Không thể gửi tin nhắn thoát, chi tiết: ", err.message);
        });
    } catch (error) {
        cError("Lỗi trong quá trình thoát vòng: ", error);
    }
}

function handleExit(socket, message) {
    try {
        const parts = message.split(' ');
        const currentIpPort = parts[1];
        const newNextIpPort = parts[2];

        cLog(`Máy ${currentIpPort} đã thoát!`);

        if (nextMachineIpPort === currentIpPort) {
            nextMachineIpPort = newNextIpPort;
            cLog(`Cập nhật máy kế tiếp thành: ${nextMachineIpPort}`);
            broadcastUpdate();


        } else {
            const [nextIp, nextPort] = nextMachineIpPort.split(':');
            const client = new net.Socket();
            client.connect(nextPort, nextIp, () => {
                client.write(message);
                client.end();
            });

            client.on('error', (err) => {
                cError("Không thể chuyển tiếp tin nhắn thoát, chi tiết: ", err.message);
            });
        }
    } catch (error) {
        cError("Lỗi khi xử lý yêu cầu thoát: ", error);
    }
}

// Reconnect event
function handleReconnect(message) {
    const newIpPort = message.split(' ')[1];
    let tokenStatus = message.split(' ')[2];
    const [nextIp, nextPort] = nextMachineIpPort.split(':');
    const client = new net.Socket();

    client.connect(nextPort, nextIp, () => {
        if (hasToken) {
            tokenStatus = 'HTOKEN';
            message = `RECONNECT ${newIpPort} ${tokenStatus}`;
        }
        client.write(message);
        client.end();
        broadcastUpdate();
    });

    client.on('error', (err) => {
        cLog('=> Không chuyển tiếp được tin nhắn y/c kết nối lại, kết nối trực tiếp với máy gửi y/c!');
        nextMachineIpPort = newIpPort;
        clearInterval(heartbeatInterval);
        startHeartbeat();
        createHeartbeatTimeout();
        cLog(`=> Đã kết nối lại, máy tiếp theo là: ${nextMachineIpPort}`);
        if (tokenStatus === 'NTOKEN' && !hasToken) sendTokenToNextMachine();
        broadcastUpdate();
    });
}

// Init data for interface
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ machineIp, machinePort, nextMachineIpPort, hasToken, inReconnecting }));
});

// Update data for interface
function broadcastUpdate() {
    const data = JSON.stringify({ machineIp, machinePort, nextMachineIpPort, hasToken, inReconnecting });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function sendLogToClient(message, type = 'log') {
    const data = JSON.stringify({ content: message, timestamp: new Date().toLocaleString(), type });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}
