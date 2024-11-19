const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dgram = require('dgram');
const cors = require('cors'); // Importe o pacote cors

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

// Lista dos clientes conectados
let clients = [];

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

    socket.emit('currentItem', currentItem); // Publicar no multicast o item disponível

    socket.on('newBid', (bid) => {
        if (bid.amount >= currentItem.currentBid + currentItem.minBidIncrement) {
            currentItem.currentBid = bid.amount; currentItem.currentBidUser = bid.user;
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

// Timer para enviar as atualizações para os clientes conectados
setInterval(() => { 
    if (currentItem.timeRemaining > 0) { 
        currentItem.timeRemaining--; io.emit('currentItem', currentItem); 
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
}, 1000);

udpServer.on('message', (msg, rinfo) => {
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

app.use(express.static('public'));

server.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
