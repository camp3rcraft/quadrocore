const WebSocket = require('ws');
const fs = require('fs');
const readline = require('readline');

class GameServer {
    constructor() {
        this.startTime = Date.now();
        this.config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        this.map = JSON.parse(fs.readFileSync('./map.json', 'utf8'));
        this.players = new Map();
        this.connectedIPs = new Map();
        this.bannedIPs = new Set();
        this.wss = new WebSocket.Server({ port: this.config.port });
        
        this.setupConsole();
        this.setupServer();
        this.gameLoop();
    }
    
    setupConsole() {
        console.log('\x1b[36m%s\x1b[0m', 'quadrocore vanilla ver.1.000');
        console.log('Starting server...');
        console.log('Loading configuration...');
        console.log('Loading map...');
        console.log('Initializing WebSocket server...');
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.on('line', (input) => {
            this.handleCommand(input);
        });
        
        const startupTime = (Date.now() - this.startTime) / 1000;
        console.log(`Done! (${startupTime.toFixed(3)}s)`);
    }
    
    handleCommand(input) {
        const parts = input.split(' ');
        const command = parts[0].toLowerCase();
        
        switch (command) {
            case '.kick':
                if (parts.length < 2) {
                    console.log('Usage: .kick <player> [reason]');
                    return;
                }
                const playerToKick = parts[1];
                const kickReason = parts.slice(2).join(' ') || 'No reason specified';
                this.kickPlayer(playerToKick, kickReason);
                break;
                
            case '.ban':
                if (parts.length < 2) {
                    console.log('Usage: .ban <player> [reason]');
                    return;
                }
                const playerToBan = parts[1];
                const banReason = parts.slice(2).join(' ') || 'No reason specified';
                this.banPlayer(playerToBan, banReason);
                break;
                
            case '.list':
                this.listPlayers();
                break;
                
            case '.stop':
                console.log('Stopping server...');
                process.exit(0);
                break;
                
            case '.restart':
                console.log('Restarting server...');
                process.exit(1); // Код 1 для перезапуска
                break;
                
            case '.help':
                console.log('Available commands:');
                console.log('.kick <player> [reason] - Kick a player');
                console.log('.ban <player> [reason] - Ban a player');
                console.log('.list - List all connected players');
                console.log('.stop - Stop the server');
                console.log('.restart - Restart the server');
                console.log('.help - Show this help message');
                break;
                
            default:
                console.log('Unknown command. Type .help for available commands.');
        }
    }
    
    kickPlayer(nickname, reason) {
        for (const [id, player] of this.players.entries()) {
            if (player.nickname === nickname) {
                const ws = this.findWebSocketByPlayerId(id);
                if (ws) {
                    ws.send(JSON.stringify({
                        type: 'kick',
                        reason: reason
                    }));
                    ws.close();
                    console.log(`Kicked player ${nickname}: ${reason}`);
                }
                return;
            }
        }
        console.log(`Player ${nickname} not found`);
    }
    
    banPlayer(nickname, reason) {
        for (const [id, player] of this.players.entries()) {
            if (player.nickname === nickname) {
                const ws = this.findWebSocketByPlayerId(id);
                if (ws) {
                    const ip = this.getPlayerIP(id);
                    if (ip) {
                        this.bannedIPs.add(ip);
                    }
                    ws.send(JSON.stringify({
                        type: 'ban',
                        reason: reason
                    }));
                    ws.close();
                    console.log(`Banned player ${nickname}: ${reason}`);
                }
                return;
            }
        }
        console.log(`Player ${nickname} not found`);
    }
    
    listPlayers() {
        console.log('Connected players:');
        this.players.forEach((player, id) => {
            console.log(`- ${player.nickname} (ID: ${id})`);
        });
        console.log(`Total: ${this.players.size} players`);
    }
    
    findWebSocketByPlayerId(playerId) {
        for (const client of this.wss.clients) {
            if (client.playerId === playerId) {
                return client;
            }
        }
        return null;
    }
    
    getPlayerIP(playerId) {
        for (const client of this.wss.clients) {
            if (client.playerId === playerId) {
                return client._socket.remoteAddress;
            }
        }
        return null;
    }
    
    setupServer() {
        this.wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress;
            
            if (this.bannedIPs.has(ip)) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'You are banned from this server' 
                }));
                ws.close();
                return;
            }
            
            let playerId = null;
            
            const currentConnections = this.connectedIPs.get(ip) || 0;
            if (currentConnections >= 1) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'Only one connection per IP is allowed' 
                }));
                ws.close();
                return;
            }
            
            this.connectedIPs.set(ip, currentConnections + 1);
            
            ws.on('message', (message) => {
                const data = JSON.parse(message);
                
                if (data.type === 'join') {
                    if (this.players.size >= this.config.maxPlayers) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Server is full' }));
                        ws.close();
                        return;
                    }
                    for (const player of this.players.values()) {
                        if (player.nickname === data.nickname) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Nickname already in use' }));
                            ws.close();
                            return;
                        }
                    }
                    playerId = Date.now().toString();
                    ws.playerId = playerId;
                    
                    const spawn = this.map.spawn || { x: 100, y: 100 };
                    const newPlayer = {
                        id: playerId,
                        nickname: data.nickname,
                        color: data.color,
                        x: spawn.x,
                        y: spawn.y,
                        velocityX: 0,
                        velocityY: 0,
                        isGrounded: false
                    };
                    
                    this.players.set(playerId, newPlayer);
                    
                    ws.send(JSON.stringify({
                        type: 'join',
                        playerId,
                        map: this.map
                    }));
                    
                    console.log(`[SERVER] Player joined: ${data.nickname} (${playerId})`);
                    this.broadcastChatMessage('system', `${data.nickname} joined the game`);
                }
                
                if (data.type === 'chat') {
                    const player = this.players.get(playerId);
                    if (player) {
                        console.log(`[SERVER] Chat from ${player.nickname}: ${data.message}`);
                        this.broadcastChatMessage(player.nickname, data.message);
                    }
                }
                
                if (data.type === 'input' && playerId) {
                    const player = this.players.get(playerId);
                    if (!player) return;
                    
                    if (data.keys.a) player.velocityX = -this.config.playerSpeed;
                    if (data.keys.d) player.velocityX = this.config.playerSpeed;
                    if (!data.keys.a && !data.keys.d) player.velocityX = 0;
                    
                    if (data.keys.space && player.isGrounded) {
                        player.velocityY = -this.config.jumpForce;
                        player.isGrounded = false;
                    }
                    
                    if (data.keys.shift) {
                        // Add any special ability here
                    }
                }
            });
            
            ws.on('close', () => {
                if (playerId) {
                    const player = this.players.get(playerId);
                    if (player) {
                        console.log(`[SERVER] Player left: ${player.nickname} (${playerId})`);
                        this.broadcastChatMessage('system', `${player.nickname} left the game`);
                    }
                    this.players.delete(playerId);
                }
                const currentConnections = this.connectedIPs.get(ip);
                if (currentConnections > 0) {
                    this.connectedIPs.set(ip, currentConnections - 1);
                }
            });
        });
    }
    
    broadcastChatMessage(sender, message) {
        const chatMessage = {
            type: 'chat',
            sender: sender,
            message: message,
            timestamp: Date.now()
        };
        
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(chatMessage));
            }
        });
    }
    
    checkCollision(player, platform) {
        return player.x < platform.x + platform.width &&
               player.x + 32 > platform.x &&
               player.y < platform.y + platform.height &&
               player.y + 32 > platform.y;
    }
    
    updatePlayer(player) {
        player.velocityY += this.config.gravity;
        player.x += player.velocityX;
        player.y += player.velocityY;
        
        player.isGrounded = false;
        for (const platform of this.map.platforms) {
            if (platform.type === 'text') continue;
            if (platform.type === 'lava' && this.checkCollision(player, platform)) {
                const spawn = this.map.spawn || { x: 100, y: 100 };
                player.x = spawn.x;
                player.y = spawn.y;
                player.velocityY = 0;
                player.velocityX = 0;
                player.isGrounded = false;
                break;
            }
            if (platform.type === 'wood') {
                if (this.checkCollision(player, platform)) {
                    if (player.velocityY > 0 && player.y + 32 > platform.y && player.y + 32 - player.velocityY <= platform.y) {
                        player.y = platform.y - 32;
                        player.velocityY = 0;
                        player.isGrounded = true;
                    }
                }
                continue;
            }
            if (platform.type === 'default' || !platform.type) {
                if (this.checkCollision(player, platform)) {
                    if (player.velocityY > 0 && player.y + 32 > platform.y) {
                        player.y = platform.y - 32;
                        player.velocityY = 0;
                        player.isGrounded = true;
                    }
                }
            }
        }
        
        if (player.x < 0) player.x = 0;
        if (player.x + 32 > this.map.width) player.x = this.map.width - 32;
        if (player.y < 0) player.y = 0;
        if (player.y + 32 > this.map.height) {
            player.y = this.map.height - 32;
            player.velocityY = 0;
            player.isGrounded = true;
        }
    }
    
    gameLoop() {
        setInterval(() => {
            this.players.forEach(player => this.updatePlayer(player));
            
            const state = {
                type: 'state',
                players: Object.fromEntries(this.players)
            };
            
            this.wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(state));
                }
            });
        }, 1000 / this.config.tickRate);
    }
}

new GameServer(); 