<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

const connectDisabled = ref(false);
const sendDisabled = ref(true);
const hostname = __IP__;
let message = $ref(``);
let username = $ref(``);
const receiveMsg = ref<Message[]>([]);
const fileinput = ref<HTMLInputElement>();

const incomingFileData: BlobPart[] = []; // 文件数据
let incomingFileInfo: FileInfo = {
  type: "file",
  name: "",
  size: 0,
}; // 文件信息

interface FileInfo {
  type: string;
  name: string;
  size: number;
}

interface User {
  clientId: string;
  username: string;
  lock?: {
    value: boolean;
    extra: any;
  };
}
interface BasicMsgBox {
  type: string;
  [props: string]: any;
}

interface PeerMsgBox extends BasicMsgBox {
  // eq clientId
  offerId: string;
  // eq another clientId
  answerId: string;
}

interface OfferMsgBox extends PeerMsgBox {
  sdp: RTCSessionDescription;
  username: string;
}

interface LockMsgBox extends BasicMsgBox {
  sponsor: string;
  invitees: string;
  lock: boolean;
}

interface Message {
  type: string;
  clientId: string;
  username: string;
  value: string;
  time: number;
}

const users = ref<User[]>([]);

const usersWithMark = computed(() => {
  return users.value.map((item) => {
    console.log(item);
    let mark = ``;
    if (item.lock?.extra.sponsor === item.clientId) {
      mark = findName(item.lock?.extra.invitees);
    } else if (item.lock?.extra.invitees === item.clientId) {
      mark = findName(item.lock?.extra.sponsor);
    }
    return {
      ...item,
      mark: item.lock?.value ? ` 📞(${mark})` : "",
    };
  });
});

function findName(id) {
  const _temp = users.value.find((item) => item.clientId === id);
  return _temp.username;
}

let websocket: WebSocket = null;
let localConnection: RTCPeerConnection = null;

let sendChannel: RTCDataChannel = null;
let receiveChannel: RTCDataChannel = null;
let clientId = Date.now().toString();
let remoteClientId: string = null;
// 防止多次对同一个用户发起连接
let remoteClientIdCopy: string = null;
let remoteUsername: string = null;
let peerTimeout = null;
const print = (...msg: any[]) => {
  console.log(`[${username}] `, ...msg);
};
function sendToServer(msg) {
  const _msg = JSON.stringify(msg);

  print(`SendToServer for ${remoteUsername}`, msg.type, _msg);

  websocket.send(_msg);
}

//连接socket服务器
function connectPeers() {
  // 打开一个 web socket
  websocket = new WebSocket(`ws://${hostname}:8081/`);
  // const wsUrl =
  //   location.protocol === "https:"
  //     ? `wss://jsapi.ghzs.com/ws/rtc`
  //     : `ws://${hostname}:3888/ws/rtc`;
  // websocket = new WebSocket(wsUrl);

  websocket.onopen = () => {
    if (websocket.readyState === websocket.OPEN) {
      console.log("已连接上...");
    }
  };
  websocket.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    console.log(msg);
    switch (msg.type) {
      case "id":
        clientId = msg.id;
        sendToServer({
          type: "join",
          clientId: clientId,
          username: username,
        });
        break;
      case "users":
        users.value = msg.users;
        break;
      case "lock-info":
        const _lockInfo = <LockMsgBox>msg;
        users.value.forEach((item) => {
          if (
            _lockInfo.invitees === item.clientId ||
            _lockInfo.sponsor === item.clientId
          ) {
            item.lock = {
              value: _lockInfo.lock,
              extra: {
                sponsor: _lockInfo.sponsor,
                invitees: _lockInfo.invitees,
              },
            };
          }
        });
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
      default:
        console.log("未知消息类型", msg);
        break;
    }
  };
  websocket.onclose = function () {
    console.log("链接已关闭...");
    // 当网络切换时，部分场景没有触发close
    if (websocket && websocket.readyState === websocket.CLOSED) {
      websocket.close();
      websocket = null;
    }
    connectDisabled.value = false;
  };
}

// 创建RTCPeerConnection
function createPeerConnection() {
  console.log("Create PeerConnection...");
  peerTimeout = setTimeout(() => {
    closeRTC();
    alert("超过10s未连接成功~连接超时");
  }, 10 * 1000);
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

  // sendChannel = localConnection.createDataChannel("sendChannel", {
  //   maxRetransmits: 50,
  //   negotiated: true,
  //   id: 1,
  // });
  sendChannel = localConnection.createDataChannel("sendChannel");
  sendChannel.onopen = (event) => {
    console.log(`数据通道已打开🚀 ${sendChannel.id}`);
    clearTimeout(peerTimeout);
    sendDisabled.value = false;
    connectDisabled.value = true;
    sendToServer({
      type: "lock",
      sponsor: clientId,
      invitees: remoteClientId,
      lock: true,
    });
  };
  sendChannel.binaryType = "arraybuffer";
  // 当发送缓冲区的大小低于其缓冲区阈值时触发此事件。这是一个提示，告诉您可以安全地发送更多数据
  sendChannel.onbufferedamountlow = (event) => {
    print("🤖", event.type);
  };
  sendChannel.onclose = (event) => {
    console.log("数据通道关闭😭");
    sendToServer({
      type: "lock",
      sponsor: clientId,
      invitees: remoteClientId,
      lock: false,
    });
    closeRTC();
    // 同时关闭ws
    disconnectPeers();
  };
  // 使用 negotiated + id 时，不会触发ondatachannel事件
  // sendChannel.onmessage = (event) => {
  //   print(`this is use negotiated data channel`, event.data);
  // };
  sendChannel.onerror = console.error;

  localConnection.ondatachannel = (event) => {
    console.log("====开始监听数据====\n", event.channel);
    receiveChannel = event.channel;
    receiveChannel.onmessage = (event) => {
      console.log(`<--- 收到数据`, typeof event.data);
      if (typeof event.data === `string`) {
        const data: Message = JSON.parse(event.data as string);
        if (data.type === `file`) {
          incomingFileInfo = data as unknown as FileInfo;
          receiveMsg.value.push({
            type: "file",
            clientId: `-`,
            username: `收到文件`,
            value: `${incomingFileInfo.name} (${readableBytes(
              incomingFileInfo.size
            )})`,
            time: Date.now(),
          });
        } else receiveMsg.value.push(data);
      } else if (event.data instanceof ArrayBuffer) {
        handleReceiveFile(event.data);
      }
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
    const candidate = event.candidate.candidate;
    const ipRegex = /([0-9]{1,3}\.){3}[0-9]{1,3}/;
    const ipMatch = candidate.match(ipRegex);
    console.log(`---> IP: ${ipMatch}`);
    sendToServer({
      type: "new-ice-candidate",
      offerId: clientId,
      answerId: remoteClientId,
      candidate: event.candidate,
    });
  }
}

function invite(user: User) {
  if (user.lock?.value) {
    return alert("对方正在通话中");
  }
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
    const data: OfferMsgBox = {
      type: "data-offer",
      offerId: clientId,
      answerId: remoteClientId,
      sdp: localConnection.localDescription,
      username: username,
    };
    sendToServer(data);
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
  // 记录邀请方的clientId
  remoteClientId = msg.offerId;
  remoteUsername = msg.username;

  // 通过ws传输answer
  sendToServer({
    type: "data-answer",
    offerId: msg.answerId,
    answerId: msg.offerId,
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
  print(clientId, username);
  const data: Message = {
    type: "chat",
    clientId,
    username: username,
    value: message,
    time: Date.now(),
  };
  sendChannel.send(JSON.stringify(data));

  message = "";
}

function sendFile() {
  if (fileinput.value.files.length > 0) {
    const file = fileinput.value.files[0];
    sendChannel.send(
      JSON.stringify({ type: "file", name: file.name, size: file.size })
    );
    readFileData();
  } else {
    alert(`请选择文件`);
  }
}
let bytesReceived = 0; // 已接收的字节数
let downloadStatus = ref(false);
// 接收对方发送的文件
function handleReceiveFile(data: any) {
  if (bytesReceived === 0) {
    // 重复接收时，清空数据
    incomingFileData.length = 0;
  }
  incomingFileData.push(data);
  bytesReceived += data.byteLength;
  // 接收完成
  if (bytesReceived === incomingFileInfo.size) {
    downloadStatus.value = true;
    bytesReceived = 0;
    alert("文件接收完成，请点击下载");
  }
}

// 格式化文件尺寸
function readableBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
}

// 读取文件内容
async function readFileData() {
  let offset = 0;
  let buffer = null;
  const file = fileinput.value.files[0];
  const chunkSize = localConnection.sctp?.maxMessageSize;
  console.log(`chunkSize: ${chunkSize}/${file.size}`);
  if (!chunkSize) return;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    buffer = await slice.arrayBuffer();
    // 为了避免数据通道的缓存队列过大，导致数据发送延迟或者阻塞。
    // 当数据通道的缓存队列大小超过了 65535 字节时，就会暂停发送数据，等待缓存队列降到阈值之下再继续发送数据。这样可以保证数据通道的稳定性和可靠性。
    if (sendChannel.bufferedAmount > 65535) {
      // 等待缓存队列降到阈值之下
      await new Promise((resolve) => {
        sendChannel.onbufferedamountlow = (ev) => {
          console.warn(
            `bufferedamountlow event! bufferedAmount: ${sendChannel.bufferedAmount}`
          );
          resolve(0);
        };
      });
    }
    // 可以发送数据了
    sendChannel.send(buffer);
    offset += buffer.byteLength;
  }
}

// 下载文件
function downloadFile() {
  if (!downloadStatus) return;
  const blob = new Blob(incomingFileData, { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = incomingFileInfo.name;
  a.click();
  URL.revokeObjectURL(url);
}

//关闭连接
function disconnectPeers() {
  if (websocket) {
    websocket.close();
    websocket = null;
  }

  connectDisabled.value = false;
}

function closeRTC() {
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

  sendDisabled.value = true;

  message = "";
}

function connectToServer() {
  if (!username) {
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
    <button :disabled="!connectDisabled" @click="disconnectPeers">
      断开Websocket
    </button>
    <div class="chatbox">
      <ul class="left-item">
        <li
          v-for="user in usersWithMark"
          :key="user.clientId"
          class="cursor"
          @click="invite(user)"
        >
          <span>{{ user.username }}</span>
          <span>{{ user.mark }}</span>
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
      <button :disabled="sendDisabled" @click="closeRTC">断开</button>
    </div>
  </div>
  <div class="send-file">
    <input type="file" name="myfile" ref="fileinput" />
    <button :disabled="sendDisabled" @click="sendFile">发送</button>
    <button :disabled="!downloadStatus" @click="downloadFile">下载</button>
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
