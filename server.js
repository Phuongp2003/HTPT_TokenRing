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
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
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
    console.error('Lỗi socket:', err);
}

function handleConnection(socket) {
    try {


        console.log('Nhận được tin!\n');

        socket.on('data', (data) => {
            const message = data.toString();
            if (message === 'TOKEN') {
                handleToken(socket);
            } else if (message.startsWith('NEXT')) {
                handleNext(socket, message);
            } else if (message.startsWith('JOIN_REQUEST')) {
                handleJoinRequest(socket, message);
            } else if (message.startsWith('JOIN')) {
                handleJoin(socket, message);
            } else if (message === 'HEARTBEAT') {
                resetHeartbeatTimeout();
            } else if (message.startsWith('RECONNECT')) {
                const newIpPort = message.split(' ')[1];
                const tokenStatus = message.split(' ')[2];
                if (waitingReconnect) {
                    nextMachineIpPort = newIpPort;
                    waitingReconnect = false;
                    console.log(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
                    if (tokenStatus === 'NTOKEN') sendTokenToNextMachine();
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
                        console.error('Lỗi client:', err);
                        // Nếu không thể kết nối tới máy kế tiếp, điều chỉnh vòng để bỏ qua máy đó
                        nextMachineIpPort = '';
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

            client.on('error', (err) => {
                console.error('Lỗi client:', err);
                // Nếu không thể kết nối tới máy kế tiếp, điều chỉnh vòng để bỏ qua máy đó
                nextMachineIpPort = '';
                broadcastUpdate();
            });

            hasToken = false; // Cập nhật trạng thái token
            broadcastUpdate(); // Cập nhật trạng thái token
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
                console.log(`Đã kết nối với máy ${inputIp}:${inputPort}, giờ tôi là máy kế tiếp.`);
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
                    client.write('HEARTBEAT');
                    client.end();
                });
                client.on('error', (err) => {
                    console.error('Lỗi client:', err);
                    waitingReconnect = true;
                });
            }
        }, 5000); // Gửi tín hiệu heartbeat mỗi 5 giây
    } catch (error) {
        console.error(error);
    }

}

function resetHeartbeatTimeout() {
    try {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = setTimeout(() => {
            console.error('Không nhận được tín hiệu heartbeat từ máy trước đó.');
            const [nextIp, nextPort] = nextMachineIpPort.split(':');
            const client = new net.Socket();
            client.connect(nextPort, nextIp, () => {
                client.write(`RECONNECT ${machineIp}:${machinePort} ${hasToken ? 'HTOKEN' : 'NTOKEN'}`);
                client.end();
            });

            client.on('error', (err) => {
                console.error('Lỗi client:', err);
                // Nếu không thể kết nối tới máy kế tiếp, điều chỉnh vòng để bỏ qua máy đó
                nextMachineIpPort = '';
                broadcastUpdate();
            });
        }, 10000); // Chờ tín hiệu heartbeat trong 10 giây
    } catch (error) {
        console.error(error);
    }

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
