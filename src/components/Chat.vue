<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const connectDisabled = ref(false);
const sendDisabled = ref(true);
const hostname = "localhost";
const message = ref(``);
const username = ref(``);
const receiveMsg = ref<Message[]>([]);

interface User {
  clientId: string;
  username: string;
}
interface BasicMsgBox {
  type: string;
  [props: string]: any;
}

interface PeerMsgBox extends BasicMsgBox {
  // eq clientId
  offerId: string;
  // eq another clientId
  anserId: string;
}

interface OfferMsgBox extends PeerMsgBox {
  sdp: RTCSessionDescription;
}

interface Message {
  clientId: string;
  username: string;
  value: string;
  time: number;
}

const users = ref<User[]>([]);

let websocket: WebSocket = null;
let localConnection: RTCPeerConnection = null;

let sendChannel: RTCDataChannel = null;
let receiveChannel: RTCDataChannel = null;
let clientId = Date.now().toString();
let remoteClientId: string = null;
// 防止多次对同一个用户发起连接
let remoteClientIdCopy: string = null;
let remoteUsername: string = null;
const print = (...msg: any[]) => {
  console.log(`[${username.value}] `, ...msg);
};
function sendToServer(msg) {
  const _msg = JSON.stringify(msg);

  print(`SendToServer for ${remoteUsername}`, msg.type, _msg);

  websocket.send(_msg);
}

//连接socket服务器
function connectPeers() {
  // 打开一个 web socket
  websocket = new WebSocket(`ws://${hostname}:8080`);
  websocket.onopen = () => {
    if (websocket.readyState === websocket.OPEN) {
      console.log("已连接上...");
    }
  };
  websocket.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case "id":
        clientId = msg.id;
        sendToServer({
          type: "username",
          clientId: clientId,
          username: username.value,
        });
        break;
      case "user-list":
        users.value = msg.users;
        break;
      case "data-offer":
        handleProcessOffer(msg);
        break;
      case "data-answer":
        handleProcessAnswer(msg);
        break;
      case "new-ice-candidate":
        handleReceiveICECandidate(msg);
        break;
    }
  };
  websocket.onclose = function () {
    console.log("链接已关闭...");
  };
}

// 创建RTCPeerConnection
function createPeerConnection() {
  console.log("Create PeerConnection...");
  localConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302",
      },
      {
        urls: "turn:" + hostname,
        username: "webrtc",
        credential: "webrtc",
      },
    ],
  });
  localConnection.onicecandidate = handleICECandidateEvent;
  localConnection.onnegotiationneeded = handleNegotiationNeededEvent;

  sendChannel = localConnection.createDataChannel("sendChannel");
  sendChannel.onopen = (event) => {
    console.log("数据通道已打开🚀");

    sendDisabled.value = false;
    connectDisabled.value = true;
  };
  sendChannel.onclose = (event) => {
    console.log("数据通道关闭😭");
    // 同时关闭ws
    disconnectPeers();
  };
  sendChannel.onerror = console.error;

  localConnection.ondatachannel = (event) => {
    console.log("====开始监听数据====\n", event.channel);
    receiveChannel = event.channel;
    receiveChannel.onmessage = (event) => {
      console.log(event.data);
      const data: Message = JSON.parse(event.data as string);
      receiveMsg.value.push(data);
    };

    receiveChannel.onclose = () => {
      console.log("[channel onopen] receive: ", receiveChannel.readyState);
      disconnectPeers();
    };
    receiveChannel.onerror = console.error;
  };
}

function handleICECandidateEvent(event) {
  if (event.candidate) {
    console.log(
      "---> 找到ICE candidate并发送(onicecandidate): " +
        event.candidate.candidate
    );
    sendToServer({
      type: "new-ice-candidate",
      offerId: clientId,
      anserId: remoteClientId,
      candidate: event.candidate,
    });
  }
}

function invite(user: User) {
  remoteUsername = user.username;
  remoteClientId = user.clientId;
  if (!connectDisabled.value) {
    alert("未连接服务器");
  } else if (localConnection) {
    alert("你暂时不能连接，因为你已经有一个连接了!");
  } else if (remoteClientId == clientId) {
    alert("不能向自己发消息");
  } else {
    createPeerConnection();
  }
}

// 呼叫初始化
async function handleNegotiationNeededEvent() {
  if (!remoteClientId && remoteClientIdCopy == remoteClientId) {
    return;
  }
  console.log("====开始谈判====");
  try {
    remoteClientIdCopy = remoteClientId;
    console.log("---> 创建 offer");
    const offer = await localConnection.createOffer();

    console.log("---> 改变与连接相关的本地描述");
    await localConnection.setLocalDescription(offer);

    console.log(
      `---> [${clientId}]发送本地描述(sdp)到到远端用户[${remoteClientId}]`
    );

    sendToServer({
      type: "data-offer",
      offerId: clientId,
      anserId: remoteClientId,
      sdp: localConnection.localDescription,
    });
  } catch (err) {
    console.error(err);
  }
}

// 接收到通信邀请offer
async function handleProcessOffer(msg: OfferMsgBox) {
  console.log("<--- 收到offer" + msg.offerId);
  if (!localConnection) {
    console.log("---> 开始创建PeerConnection并寻找ICE");
    createPeerConnection();
  }
  // // msg.sdp {type: "offer", sdp: "v=0\r\no=xxxx"}
  const desc = new RTCSessionDescription(msg.sdp);

  console.log("<--- 格式化远端描述并设置远端描述(setRemoteDescription)");
  await localConnection.setRemoteDescription(desc);

  console.log("---> 创建并向呼叫者发送应答(answer)");
  await localConnection.setLocalDescription(
    await localConnection.createAnswer()
  );

  // 通过ws传输answer
  sendToServer({
    type: "data-answer",
    offerId: msg.anserId,
    anserId: msg.offerId,
    sdp: localConnection.localDescription,
  });
}

// 接收者已经接听了我们的通信
async function handleProcessAnswer(msg: OfferMsgBox) {
  console.log("<--- 接收者已经接听了我们的通信🎉");
  try {
    // msg.sdp {type: "answer", sdp: "v=0\r\no=xxx"}
    const desc = new RTCSessionDescription(msg.sdp);
    console.log(`<--- 本地设置远端描述(setRemoteDescription)`);
    await localConnection.setRemoteDescription(desc);
  } catch (err) {
    console.error(err);
  }
}

async function handleReceiveICECandidate(msg) {
  const candidate = new RTCIceCandidate(msg.candidate);
  console.log(
    "<--- 添加接受者的 ICE 候选地址信息(addIceCandidate)：" +
      JSON.stringify(candidate)
  );
  try {
    await localConnection.addIceCandidate(candidate);
  } catch (err) {
    console.error(err);
  }
}

function sendMessage() {
  console.log(clientId, username.value);
  const data: Message = {
    clientId,
    username: username.value,
    value: message.value,
    time: Date.now(),
  };
  sendChannel.send(JSON.stringify(data));

  message.value = "";
}

//关闭连接
function disconnectPeers() {
  if (sendChannel) {
    sendChannel.onopen = null;
    sendChannel.onclose = null;
    sendChannel.close();
    sendChannel = null;
  }
  if (receiveChannel) {
    receiveChannel.onmessage = null;
    receiveChannel.onopen = null;
    receiveChannel.onclose = null;
    receiveChannel.close();
    receiveChannel = null;
  }
  if (localConnection) {
    localConnection.onicecandidate = null;
    localConnection.onnegotiationneeded = null;
    localConnection.ondatachannel = null;
    localConnection.close();
    localConnection = null;
  }
  if (websocket) {
    websocket.close();
    websocket = null;
  }

  connectDisabled.value = false;

  sendDisabled.value = true;

  message.value = "";
}

function connectToServer() {
  if (!username.value) {
    alert("用户名不能为空！");
    return;
  }

  connectDisabled.value = true;
  connectPeers();
}

function DateFotmat(date: Date, fmt: string) {
  const o: any = {
    "M+": date.getMonth() + 1, //月份
    "d+": date.getDate(), //日
    "h+": date.getHours(), //小时
    "m+": date.getMinutes(), //分
    "s+": date.getSeconds(), //秒
    "q+": Math.floor((date.getMonth() + 3) / 3), //季度
    S: date.getMilliseconds(), //毫秒
  };

  if (/(y+)/.test(fmt))
    fmt = fmt.replace(
      RegExp.$1,
      (date.getFullYear() + "").substr(4 - RegExp.$1.length)
    );

  for (const k in o) {
    if (new RegExp("(" + k + ")").test(fmt))
      fmt = fmt.replace(
        RegExp.$1,
        RegExp.$1.length === 1 ? o[k] : ("00" + o[k]).substr(("" + o[k]).length)
      );
  }
  return fmt;
}

onBeforeUnmount(() => {
  disconnectPeers();
});
</script>
<template>
  <div class="wrapper">
    <label for="username"
      >用户名：
      <input
        type="text"
        name="username"
        id="username"
        placeholder="请输入用户名"
        v-model="username"
      />
    </label>
    <button :disabled="connectDisabled" @click="connectToServer">连接</button>
    <button :disabled="!connectDisabled" @click="disconnectPeers">断开</button>
    <div class="chatbox">
      <ul class="left-item">
        <li
          v-for="user in users"
          :key="user.clientId"
          class="cursor"
          @click="invite(user)"
        >
          {{ user.username }}
        </li>
      </ul>
      <div id="receiveBox" class="right-item">
        <div v-for="(item, index) in receiveMsg" :key="index">
          <p>{{ DateFotmat(new Date(item.time), "yyyy-MM-dd hh:mm:ss") }}</p>
          <p>
            <span class="author"
              >{{ item.username }}
              <span class="sub">({{ item.clientId }})</span> :</span
            >
            <span v-html="item.value"></span>
          </p>
        </div>
      </div>
    </div>

    <div class="messagebox">
      <label for="message"
        >输入一个消息：
        <input
          type="text"
          name="message"
          id="message"
          placeholder="请输入消息"
          inputmode="text"
          size="60"
          maxlength="120"
          v-model="message"
        />
      </label>
      <button :disabled="sendDisabled" @click="sendMessage">发送</button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.chatbox {
  display: flex;
  border: 1px solid #f9f9f9;
  border-radius: 8px;
  min-height: 100px;
  margin: 16px;
}
input {
  border: 0;
  outline: none;
  background: transparent;
  padding: 0;
}
.cursor {
  cursor: pointer;
}
.right-item {
  padding: 0 10px;
  font-weight: bold;
  p {
    text-align: left;
    margin: 0;
    .author {
      color: #999;
    }
    .sub {
      font-size: 10px;
    }
    &.time {
      color: #999;
    }
  }
}
</style>