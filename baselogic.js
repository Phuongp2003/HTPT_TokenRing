const net = require('net');
const readline = require('readline');
const os = require('os');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let machineIp = getLocalIpAddress();
let machinePort = 3000;
let nextMachineIpPort = '';

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
    console.log(`${machineIp}:${machinePort} nhận được token.`);
    waitForUserToPressEnter();
}

function handleJoin(socket, message) {
    const [newMachineIp, newMachinePort] = message.split(' ')[1].split(':');
    if (newMachineIp === machineIp && newMachinePort === String(machinePort)) {
        return;
    }

    // Gửi yêu cầu xếp chỗ gia nhập đến máy kế tiếp
    const client = new net.Socket();
    client.connect(nextMachineIpPort.split(':')[1], nextMachineIpPort.split(':')[0], () => {
        client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${machineIp}:${machinePort}`);
        client.end();
    });

    console.log(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được gửi.`);
}

function handleJoinRequest(socket, message) {
    const parts = message.split(' ');
    const newMachineIpPort = parts[1];
    const requesterIpPort = parts[2];
    const [newMachineIp, newMachinePort] = newMachineIpPort.split(':');
    const [requesterIp, requesterPort] = requesterIpPort.split(':');

    if (nextMachineIpPort === `${requesterIp}:${requesterPort}`) {
        const oldNextMachineIpPort = nextMachineIpPort;
        nextMachineIpPort = `${newMachineIp}:${newMachinePort}`;

        const client = new net.Socket();
        client.connect(newMachinePort, newMachineIp, () => {
            client.write(`NEXT ${oldNextMachineIpPort}`);
            client.end();
        });

        console.log(`Máy mới (${newMachineIp}:${newMachinePort}) đã gia nhập ngay sau ${machineIp}:${machinePort}.`);
    } else {
        // Chuyển tiếp yêu cầu xếp chỗ gia nhập đến máy kế tiếp
        const client = new net.Socket();
        client.connect(nextMachineIpPort.split(':')[1], nextMachineIpPort.split(':')[0], () => {
            client.write(`JOIN_REQUEST ${newMachineIp}:${newMachinePort} ${requesterIp}:${requesterPort}`);
            client.end();
        });

        console.log(`Yêu cầu xếp chỗ gia nhập cho máy mới (${newMachineIp}:${newMachinePort}) đã được chuyển tiếp.`);
    }
}

function handleNext(socket, message) {
    nextMachineIpPort = message.split(' ')[1];
    console.log(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
}

function handleError(socket, err) {
    console.error('Lỗi socket:', err);
}

function handleConnection(socket) {
    console.log('Kết nối từ máy:', `${socket.remoteAddress}:${socket.remotePort}`);

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
        }
    });

    socket.on('error', (err) => handleError(socket, err));
}

function sendTokenToNextMachine() {
    if (nextMachineIpPort) {
        const [nextIp, nextPort] = nextMachineIpPort.split(':');
        const client = new net.Socket();
        client.connect(nextPort, nextIp, () => {
            client.write('TOKEN');
            client.end();
        });

        client.on('error', (err) => console.error('Lỗi client:', err));
    } else {
        console.error('Không có thông tin máy kế tiếp.');
    }
}

function waitForUserToPressEnter() {
    if (rl.closed) {
        console.error('Readline interface đã bị đóng.');
        return;
    }
    rl.question('Nhấn Enter để chuyền token cho máy tiếp theo: ', () => {
        sendTokenToNextMachine();
    });
}

function joinRing() {
    rl.question('Nhập IP:PORT của máy đã có trong vòng (hoặc nhấn Enter để tạo vòng mới): ', (input) => {
        if (input) {
            const [inputIp, inputPort] = input.split(':');
            nextMachineIpPort = `${inputIp}:${inputPort}`;
            const client = new net.Socket();
            client.connect(inputPort, inputIp, () => {
                console.log(`Đã kết nối với máy ${inputIp}:${inputPort}, giờ tôi là máy kế tiếp.`);
                client.write(`JOIN ${machineIp}:${machinePort}`);
                client.end();
            });
        } else {
            nextMachineIpPort = `${machineIp}:${machinePort}`;
            console.log('Máy này là máy đầu tiên trong vòng.');
            sendTokenToNextMachine();
        }
    });
}

function startServer(port) {
    const server = net.createServer(handleConnection);
    server.listen(port, machineIp, () => {
        machinePort = port;
        console.log(`Máy ${machineIp}:${machinePort} đang chạy...`);
        joinRing();
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Cổng ${port} đang bận, thử cổng khác...`);
            startServer(port + 1);
        } else {
            console.error('Lỗi khi khởi động server:', err);
        }
    });
}

const args = process.argv.slice(2);
const initialPort = args[0]
    ? parseInt(args[0], 10)
    : process.env.PORT
        ? parseInt(process.env.PORT, 10)
        : 3000;

startServer(initialPort);
