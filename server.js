const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dgram = require('dgram');
const cors = require('cors');
const NodeRSA = require('node-rsa');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { clearInterval } = require('timers');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // permitindo a origem
        methods: ["GET", "POST"]
    }
});

const multicastAddress = '224.0.0.5'; // Endereço multicast
const multicastPort = 41234; // Porta multicast

const udpServer = dgram.createSocket('udp4');

// Permitir CORS para todas as rotas
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

let clients = [], timer = null, symmetricKey;

// Dados do leilão
let currentItem = {
    id: 1, description: 'Item de teste',
    initialBid: 100,
    minBidIncrement: 10,
    currentBid: 100,
    currentBidUser: null,
    timeRemaining: 60
};

io.on('connection', (socket) => {
    console.log(`Novo cliente WebSocket conectado - ${socket.id}`);
    clients.push(socket);

    if (clients.length === 1) {
        startTimer();
    } else if (!clients.length > 0) {
        stopTimer();
    }

    socket.emit('currentItem', currentItem); // Publicar no multicast o item disponível

    socket.on('newBid', (bid) => {
        if (bid.amount >= currentItem.currentBid + currentItem.minBidIncrement) {
            currentItem.currentBid = bid.amount;
            currentItem.currentBidUser = bid.user;
            io.emit('currentItem', currentItem);
            udpServer.send(JSON.stringify(currentItem), multicastPort, multicastAddress);
            console.log(`Novo lance: ${bid.amount} por ${bid.user}`);
        } else {
            socket.emit('error', 'Lance abaixo do mínimo permitido.');
        }
    });

    socket.on('disconnect', () => {
        clients = clients.filter(client => client !== socket);
        console.log(`Cliente WebSocket desconectado - ${socket.id}`);
    });
});

// Timer para enviar as atualizações para todos clientes conectados
const startTimer = () => {

    if (timer) {
        return;
    }

    timer = setInterval(() => {
        if (clients.length > 0) {
            if (currentItem.timeRemaining > 0) {
                currentItem.timeRemaining--;
                io.emit('currentItem', currentItem);
                udpServer.send(JSON.stringify(currentItem), multicastPort, multicastAddress);
            } else {
                // Leilão encerrado, iniciar novo item
                currentItem = {
                    ...currentItem,
                    id: currentItem.id + 1,
                    currentBid: currentItem.initialBid,
                    currentBidUser: null,
                    timeRemaining: 60
                };
                io.emit('currentItem', currentItem);
                udpServer.send(JSON.stringify(currentItem), multicastPort, multicastAddress);
            }
        } else {
            stopTimer();
        }
    }, 1000);
}

const stopTimer = function () {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('Timer parado.');
    }
}

const isValidCPF = (cpf) => {
    return cpf && cpf.length === 11;
};

const getPublicKey = (cpf) => {
    const filePath = path.join(__dirname, 'certs', cpf, `${cpf}.pem`);

    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
    }

    return null;
};

const getName = (cpf) => {
    const filePath = path.join(__dirname, 'certs', cpf, `${cpf}.json`);

    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        const parsedData = JSON.parse(fileContent.trim());

        return parsedData.name || null;
    }

    return null;
}

const encryptWithPublicKey = (publicKey, message) => {
    const key = new NodeRSA(publicKey);
    key.setOptions({ encryptionScheme: 'pkcs1' });
    return key.encrypt(message, 'base64');
};

const normalizeKey = (key) => key.replace(/(\r\n|\n|\r)/gm, '').trim();

const generateSymmetricKey = () => crypto.randomBytes(32).toString('hex');

udpServer.on('message', (msg, rinfo) => {
    const serverAddress = udpServer.address().address;

    // Ignorar mensagens enviadas pelo próprio servidor
    if (rinfo.address === serverAddress) {
        return;
    }

    console.log(`Mensagem recebida: ${msg} de ${rinfo.address}:${rinfo.port}`);
    clients.forEach(client => {
        client.emit('message', msg.toString()); // Emitindo para todos os clientes no multicast
    });
});

udpServer.on('listening', () => {
    udpServer.addMembership(multicastAddress);
    console.log(`Servidor UDP escutando no endereço ${multicastAddress}:${multicastPort}`);
});

udpServer.bind(multicastPort, () => {
    console.log('Servidor UDP está ouvindo...');
});

app.post('/authenticate', (req, res) => {
    const { cpf, publicKey } = req.body;

    if (isValidCPF(cpf)) {
        const storedPublicKey = getPublicKey(cpf);
        const storedName = getName(cpf);

        if (!storedPublicKey) {
            return res.status(400).json({ success: false, message: 'Chave pública não encontrada para validação.' });
        }

        if (normalizeKey(storedPublicKey) === normalizeKey(publicKey)) {
            const user = { nome: storedName, cpf }

            const encryptedSymmetricKey = encryptWithPublicKey(publicKey, symmetricKey);
            const encryptedUserInfo = encryptWithPublicKey(publicKey, user);
            const encryptedMulticastAddress =  encryptWithPublicKey(publicKey, multicastAddress);

            res.json({
                success: true,
                encryptedUserInfo,
                encryptedSymmetricKey,
                encryptedMulticastAddress,
            });
        } else {
            res.status(400).json({ success: false, message: 'Chave pública inválida ou não encontrada.' });
        }
    } else {
        res.status(400).json({ success: false, message: 'CPF inválido.' });
    }
});

server.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
    symmetricKey = generateSymmetricKey(); // Chave simétrica ao iniciar server
});
