const net = require('net');
const os = require('os');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const WebSocket = require('ws');

let machineIp = getLocalIpAddress();
let machinePort = 3000;
let nextMachineIpPort = '';
let hasToken = false; // Variable to track token status
let waitingReconnect = false;

// Token ring server by net (tcp)

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

function handleToken(socket) {
    try {
        console.log(`${machineIp}:${machinePort} nhận được token.`);
        hasToken = true;
        broadcastUpdate();
    } catch (error) {
        console.error(error);
    }
}

function handleJoin(socket, message) {
    try {
        const [newMachineIp, newMachinePort] = message.split(' ')[1].split(':');
        console.log("🚀 ~ handleJoin ~ newMachineIp, newMachinePort:", newMachineIp, newMachinePort)
        if (newMachineIp === machineIp && newMachinePort === String(machinePort)) {
            return;
        }

        const client = new net.Socket();
        client.connect(parseInt(nextMachineIpPort.split(':')[1], 10), nextMachineIpPort.split(':')[0], () => {
            client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${machineIp}:${machinePort}`);
            client.end();
        });

        console.log(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được gửi.`);
    } catch (error) {
        console.error(error);
    }

}

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
            console.log(`Máy mới (${newMachineIp}:${newMachinePort}) đã gia nhập ngay sau ${machineIp}:${machinePort}.`);
        } else {
            const client = new net.Socket();
            client.connect(nextMachineIpPort.split(':')[1], nextMachineIpPort.split(':')[0], () => {
                client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${requesterIp}:${requesterPort}`);
                client.end();
            });

            console.log(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được chuyển tiếp.`);
        }
    } catch (error) {
        console.error(error);
    }

}

function handleNext(socket, message) {
    try {
        nextMachineIpPort = message.split(' ')[1];
        console.log(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
    } catch (error) {
        console.error(error);
    }

}

function handleError(socket, err) {
    // Không dùng nhiều
    console.error('Lỗi socket:', err);
}

function handleConnection(socket) {
    try {
        socket.on('data', (data) => {
            let message = data.toString();
            console.log("Nhận được tin nhắn, nội dung: :", message)
            if (message === 'TOKEN') {
                handleToken(socket);
            } else if (message.startsWith('NEXT')) {
                handleNext(socket, message);
            } else if (message.startsWith('JOIN_REQUEST')) {
                handleJoinRequest(socket, message);
            } else if (message.startsWith('JOIN')) {
                handleJoin(socket, message);
            } else if (message.startsWith('HEARTBEAT')) {
                resetHeartbeatTimeout(message);
            } else if (message.startsWith('RECONNECT')) {
                const newIpPort = message.split(' ')[1];
                let tokenStatus = message.split(' ')[2];

                if (waitingReconnect) {
                    nextMachineIpPort = newIpPort;
                    startHeartbeat();
                    console.log(`Kết nối lại với máy kế tiếp: ${nextMachineIpPort}`);
                    if (tokenStatus === 'NTOKEN') sendTokenToNextMachine();
                    createHeartbeatTimeout()
                    waitingReconnect = false;
                    broadcastUpdate();
                } else {
                    const [nextIp, nextPort] = nextMachineIpPort.split(':');
                    const client = new net.Socket();
                    client.connect(nextPort, nextIp, () => {
                        if (hasToken) {
                            tokenStatus = 'HTOKEN';
                            message = `RECONNECT ${newIpPort} ${tokenStatus}`;
                        }
                        client.write(message);
                        client.end();
                    });

                    client.on('error', (err) => {
                        console.error('Không chuyển tiếp được tin nhắn y/c kết nối lại, kết nối trực tiếp với máy gửi y/c! Chi tiết lỗi: :', err);
                        nextMachineIpPort = newIpPort;
                        waitingReconnect = false;
                        startHeartbeat();
                        console.log(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
                        if (tokenStatus === 'NTOKEN') sendTokenToNextMachine();
                        broadcastUpdate();
                    });
                }
            }
        });

        socket.on('error', (err) => handleError(socket, err));
        broadcastUpdate();
    } catch (error) {
        console.error(error);
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
                console.error('Không thể gửi token đến máy tiếp theo, chi tiết: ', err);
                // Nếu không thể kết nối tới máy kế tiếp, điều chỉnh vòng để bỏ qua máy đó
                nextMachineIpPort = '';
                hasToken = true;
                broadcastUpdate();
            });
        } else {
            console.error('Không có thông tin máy kế tiếp.');
        }
    } catch (error) {
        console.error(error);
    }

}

function joinRing(ipPort) {
    try {
        if (ipPort && ipPort !== `${machineIp}:${machinePort}`) {
            const [inputIp, inputPort] = ipPort.split(':');
            nextMachineIpPort = `${inputIp}:${inputPort}`;
            const client = new net.Socket();
            client.connect(parseInt(inputPort, 10), inputIp, () => {
                console.log(`Máy ${inputIp}:${inputPort} đã kết nối, tiến hành kết nối với máy ${nextMachineIpPort} để tham gia vòng!`);
                client.write(`JOIN ${machineIp}:${machinePort}`);
                client.end();
            });
        } else {
            nextMachineIpPort = `${machineIp}:${machinePort}`;
            hasToken = true;
            console.log('Máy này là máy đầu tiên trong vòng.');
            sendTokenToNextMachine();
        }
        broadcastUpdate();
    } catch (error) {
        console.error(error);
    }

}

let heartbeatInterval;
let heartbeatTimeout;

function startHeartbeat() {
    try {
        heartbeatInterval = setInterval(() => {
            if (nextMachineIpPort) {
                const [nextIp, nextPort] = nextMachineIpPort.split(':');
                const client = new net.Socket();
                client.connect(nextPort, nextIp, () => {
                    client.write(`HEARTBEAT ${machineIp}:${machinePort}`);
                    client.end();
                });
                client.on('error', (err) => {
                    console.error('Không thể gửi heartbeat đến máy sau đó, vào trạng thái chờ kết nói lại! Chi tiết: ', err);
                    clearInterval(heartbeatInterval);
                    clearTimeout(heartbeatTimeout);
                    waitingReconnect = true;
                });
            }
        }, 5000); // Gửi tín hiệu heartbeat mỗi 5 giây
    } catch (error) {
        console.error(error);
    }

}

function resetHeartbeatTimeout(message) {
    try {
        const parts = message.split(' ');
        const messageIp = parts[1];
        console.log("🚀 ~ resetHeartbeatTimeout ~ messageIp:", messageIp)


        if (messageIp === `${machineIp}:${machinePort}`) {
            clearTimeout(heartbeatTimeout);
            createHeartbeatTimeout();
        } else {
            const client = new net.Socket();
            const [nextIp, nextPort] = nextMachineIpPort.split(':');
            client.connect(nextPort, nextIp, () => {
                client.write(message);
                client.end();
            });
            client.on('error', (err) => {
                console.error('Không thể chuyển tiếp heartbeat đến máy tiếp theo, chi tiết: ', err);
            });
        }
    } catch (error) {
        console.error(error);
    }
}

function createHeartbeatTimeout() {
    const client = new net.Socket();
    const [nextIp, nextPort] = nextMachineIpPort.split(':');
    heartbeatTimeout = setTimeout(() => {
        console.error('Không nhận lại được tin nhẵn đã gửi! Gửi yêu cầu kết nối lại!');
        client.connect(nextPort, nextIp, () => {
            client.write(`RECONNECT ${machineIp}:${machinePort} ${hasToken ? 'HTOKEN' : 'NTOKEN'}`);
            console.log('Gửi y/c kết nối thành công!')
            client.end();
        });

        client.on('error', (err) => {
            console.error('Không thể gửi yêu cầu reconnect đến máy tiếp theo, tiến hành huỷ vòng, chi tiết: ', err);
            nextMachineIpPort = `${machineIp}:${machinePort}`;
            hasToken = true;
            broadcastUpdate();
        });
    }, 10000);
}

function startServer(port) {
    try {
        const server = net.createServer(handleConnection);
        server.listen(port, machineIp, () => {
            machinePort = port;
            console.log(`Máy ${machineIp}:${machinePort} đang chạy...`);
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Cổng ${port} đang bận, thử cổng khác...`);
                startServer(port + 1);
            } else {
                console.error('Lỗi khi khởi động server:', err);
            }
        });
    } catch (error) {
        console.error(error);
    }

}

const args = process.argv.slice(2);
const initialPort = args[0]
    ? parseInt(args[0], 10)
    : process.env.PORT
        ? parseInt(process.env.PORT, 10)
        : 3000;

startServer(initialPort);

// Interface server

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
    res.render('index', { machineIp, machinePort, nextMachineIpPort, hasToken });
});
app.use(bodyParser.json());

app.post('/send-token', (req, res) => {
    sendTokenToNextMachine();
    res.send('Token sent to next machine.');
});

app.post('/join-ring', (req, res) => {
    const { ipPort } = req.body;
    joinRing(ipPort);
    res.send('Join ring request processed.');
});

const server = app.listen(initialPort, () => {
    console.log(`Interface server running at http://localhost:${initialPort}`);
    startHeartbeat();
});

// WebSocket server for realtime update

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ machineIp, machinePort, nextMachineIpPort, hasToken }));
});

function broadcastUpdate() {
    const data = JSON.stringify({ machineIp, machinePort, nextMachineIpPort, hasToken });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}
