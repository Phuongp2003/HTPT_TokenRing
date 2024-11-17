const net = require('net');
const readline = require('readline');
const os = require('os');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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

// IP và cổng của máy hiện tại
let machineIp = getLocalIpAddress();
let machinePort = 3000; // Mặc định cổng đầu tiên
let nextMachineIpPort = ''; // IP và cổng của máy kế tiếp

// Tạo server cho máy hiện tại
const server = net.createServer((socket) => {
    console.log('Kết nối từ máy:', socket.remoteAddress);

    socket.on('data', (data) => {
        const message = data.toString();
        if (message === 'TOKEN') {
            console.log(`${machineIp}:${machinePort} nhận được token.`);
            waitForUserToPressEnter();
        } else if (message.startsWith('JOIN')) {
            const [newMachineIp, newMachinePort] = message.split(' ')[1].split(':');

            // Kiểm tra nếu địa chỉ IP và cổng trùng với chính máy hiện tại
            if (newMachineIp === machineIp && newMachinePort === String(machinePort)) {
                console.log('Bỏ qua JOIN từ chính máy hiện tại.');
                return;
            }

            // Lưu lại next cũ
            const oldNextMachineIpPort = nextMachineIpPort;

            // Cập nhật next của máy hiện tại là máy mới
            nextMachineIpPort = `${newMachineIp}:${newMachinePort}`;

            // Gửi thông tin next cũ cho máy mới
            const client = new net.Socket();
            client.connect(newMachinePort, newMachineIp, () => {
                client.write(`NEXT ${oldNextMachineIpPort}`);
                client.end();
            });

            console.log(`Máy mới (${newMachineIp}:${newMachinePort}) đã gia nhập ngay sau ${machineIp}:${machinePort}.`);
        } else if (message.startsWith('NEXT')) {
            // Cập nhật máy kế tiếp dựa trên thông tin nhận được
            nextMachineIpPort = message.split(' ')[1];
            console.log(`Cập nhật máy kế tiếp: ${nextMachineIpPort}`);
        }
    });


    socket.on('error', (err) => console.error('Lỗi socket:', err));
});

// Hàm chờ người dùng nhấn Enter để truyền token
function waitForUserToPressEnter() {
    if (rl.closed) {
        console.error('Readline interface đã bị đóng.');
        return;
    }
    rl.question('Nhấn Enter để chuyền token cho máy tiếp theo: ', () => {
        sendTokenToNextMachine();
    });
}

// Gửi token đến máy kế tiếp
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

// Tham gia hoặc tạo vòng
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
            sendTokenToNextMachine(); // Bắt đầu chuyền token
        }
    });
}

// Hàm khởi động server và kiểm tra cổng
function startServer(port) {
    server.listen(port, machineIp, () => {
        machinePort = port;
        console.log(`Máy ${machineIp}:${machinePort} đang chạy...`);
        joinRing(); // Gia nhập hoặc tạo vòng
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Cổng ${port} đang bận, thử cổng khác...`);
            startServer(port + 1); // Thử cổng kế tiếp
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
