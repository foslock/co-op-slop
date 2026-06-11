import './style.css';
import type { PlayerInfo } from 'shared';
import { Net } from './net';
import { UI } from './screens';
import { Game } from './game/game';
import { unlockAudio } from './audio';

const gameContainer = document.getElementById('game')!;
const uiRoot = document.getElementById('ui')!;

let net: Net | null = null;
let game: Game | null = null;
let myId = '';
let roomCode = '';
let hostId = '';
let players: PlayerInfo[] = [];
let appState: 'home' | 'lobby' | 'loading' | 'playing' | 'results' = 'home';

const ui = new UI(uiRoot, {
  onCreate: (name) => void enterRoom({ t: 'create', name, cos: ui.cosmetics }),
  onJoin: (name, code) => void enterRoom({ t: 'join', code, name, cos: ui.cosmetics }),
  onReady: (ready) => net?.send({ t: 'ready', ready }),
  onCosmetics: (cos) => net?.send({ t: 'cos', cos }),
  onSeed: (seed) => net?.send({ t: 'seed', seed }),
  onStart: () => net?.send({ t: 'start' }),
  onPlayAgain: () => net?.send({ t: 'again' }),
});

window.addEventListener('pointerdown', unlockAudio, { once: true });

function teardownGame() {
  game?.dispose();
  game = null;
}

function goHome(message?: string) {
  teardownGame();
  net?.disconnect();
  net = null;
  appState = 'home';
  ui.showHome();
  if (message) ui.errorToast(message);
}

async function enterRoom(joinMsg: { t: 'create'; name: string; cos: PlayerInfo['cosmetics'] } | { t: 'join'; code: string; name: string; cos: PlayerInfo['cosmetics'] }) {
  try {
    net = new Net();
    await net.connect();
  } catch {
    ui.errorToast('Could not reach the server');
    net = null;
    return;
  }
  bindNet(net);
  net.onClose = () => goHome('Connection lost');
  net.send(joinMsg);
}

function bindNet(n: Net) {
  n.on('error', (msg) => {
    ui.errorToast(msg.msg);
    if (appState === 'home') {
      n.disconnect();
      net = null;
    }
  });
  n.on('joined', (msg) => {
    myId = msg.you;
    roomCode = msg.code;
    hostId = msg.hostId;
    players = msg.players;
    appState = 'lobby';
    ui.showLobby(roomCode);
    ui.updateLobby(players, hostId, myId, msg.seed);
  });
  n.on('lobby', (msg) => {
    players = msg.players;
    hostId = msg.hostId;
    if (appState === 'lobby') ui.updateLobby(players, hostId, myId, msg.seed);
  });
  n.on('starting', (msg) => {
    void startGame(msg.seed);
  });
  n.on('go', (msg) => {
    if (!game) return;
    appState = 'playing';
    ui.clear();
    game.start(msg.startAt);
  });
  n.on('lobbyAgain', () => {
    teardownGame();
    appState = 'lobby';
    ui.showLobby(roomCode);
    ui.updateLobby(players, hostId, myId, '');
  });
}

async function startGame(seed: string) {
  if (!net) return;
  appState = 'loading';
  teardownGame();
  ui.showLoading('Building the tower…');
  game = new Game(gameContainer, uiRoot, net, seed, players, myId, (info) => {
    appState = 'results';
    document.exitPointerLock();
    ui.showResults(info, players, myId === hostId);
  });
  try {
    await game.init();
  } catch (err) {
    console.error('Failed to start game', err);
    goHome('Something went wrong while loading the level');
    return;
  }
  ui.showLoading('Waiting for the team…');
  net.send({ t: 'loaded' });
}

ui.showHome();
