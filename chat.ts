import WebSocket, { WebSocketServer } from "ws";
import http from "node:http";
const port = 8080;
const server = http.createServer((request, response) => {
  console.log(`[${new Date()}] Received request from ${request.url}`);
  response.writeHead(404);
  response.end();
});
let nextId = Date.now().toString();
let connectionQueue: Connection[] = [];

interface BasicMsgBox {
  type: string;
  [props: string]: any;
}

interface JoinMsgBox extends BasicMsgBox {
  clientId: string;
  username: string;
}

interface PeerMsgBox extends BasicMsgBox {
  // eq clientId
  offerId: string;
  // eq another clientId
  answerId: string;
}

interface OfferMsgBox extends PeerMsgBox {
  sdp: string;
  username: string
}

interface IceMsgBox extends PeerMsgBox {
  candidate: string;
}

class Connection {
  clientId: string;
  username: string;
  connection: WebSocket;
  constructor(clientId: string, username: string, connection: WebSocket) {
    this.clientId = clientId;
    this.username = username;
    this.connection = connection;
  }
}

var wsServer = new WebSocketServer({
  server: server,
});

const print = (...msg: any[]) => {
  console.log(`[${new Date()}] `, ...msg);
};

wsServer.on("connection", (ws) => {
  ws.on("error", console.error);
  const currentId = nextId;
  connectionQueue.push(new Connection(currentId, ``, ws));
  nextId = (Number(currentId) + 1).toString();
  const callbackMsg = {
    type: "id",
    id: currentId,
  };
  print(connectionQueue.map(item => item.clientId))
  ws.send(JSON.stringify(callbackMsg));
  ws.on("message", (message) => {
    const msg = message.toString("utf8");
    const msgBox: BasicMsgBox = JSON.parse(msg);
    switch (msgBox.type) {
      case "join":
        //新用户进入
        const _msg = msgBox as JoinMsgBox;
        print(`[${_msg.username}] 进入聊天室(${connectionQueue.length})`);
        const _ins = connectionQueue.find(
          (item) => item.clientId == _msg.clientId
        );
        if (_ins) {
          _ins.username = _msg.username;
        }
        broadcast();
        break;
      default:
        //其他所有信息只往单个用户发送
        const _msg_ = msgBox as PeerMsgBox;
        print(`[${_msg_.offerId}] to [${_msg_.answerId}] /${_msg_.type}`);

        let instance = connectionQueue.find(
          (item) => item.clientId == _msg_.answerId
        );
        if (instance) {
          print(msg);
          instance.connection.send(msg);
        }
        break;
    }
  });

  ws.on("close", (code) => {
    //用户离开
    connectionQueue = connectionQueue.filter(
      (el) => el.connection.readyState === WebSocket.OPEN
    );
    print(`${code}/${connectionQueue.length}: disconnected.`);
    broadcast();
  });
});

const broadcast = () => {
  const users = connectionQueue.map((item) => {
    return { clientId: item.clientId, username: item.username };
  });
  connectionQueue.forEach((item) => {
    item.connection.send(
      JSON.stringify({
        type: "users",
        users,
      })
    );
  });
};

server.listen(port, () => {
  console.log(`[${new Date()}] Server is listening on port ${port}`);
});
