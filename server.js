const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dgram = require('dgram');
const cors = require('cors');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { clearInterval } = require('timers');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // permitindo a origem
        methods: ["GET", "POST"]
    }
});

const multicastAddress = '224.0.0.5'; // Endereço multicast atualizado
const multicastPort = 41234; // Porta multicast

const udpServer = dgram.createSocket('udp4');

// Permitir CORS para todas as rotas
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

let clients = [], timer = null;

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

const encryptWithPublicKey = (publicKey, message) => {
    const buffer = Buffer.from(message, 'utf8');
    const encrypted = crypto.publicEncrypt(publicKey, buffer);
    return encrypted.toString('base64');
};

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
    console.log(req.body);
    const { cpf } = req.body;

    if (isValidCPF(cpf)) {
        const publicKey = getPublicKey(cpf);

        if (publicKey) {
            const encryptedMessage = encryptWithPublicKey(publicKey, 'Mensagem segura');

            res.json({
                success: true,
                user: { nome: 'teste', cpf: '12345678900' },
                encryptedMessage: encryptedMessage
            });

        } else {
            res.json({ success: false, message: 'Chave pública não encontrada para este CPF.' });
        }

    } else {
        res.json({ success: false, message: 'CPF inválido' });
    }
});

server.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});
