import socks from 'socksv5';
import nats, { JSONCodec } from 'nats';
import net from 'node:net';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

const natsClient = await nats.connect({
  port: 42223,
  token: '1234567890'
});

const jsonCodec = new JSONCodec();

const connections = {};

async function setupResponder(subject, func, decodeJson = true) {
  await natsClient.subscribe(subject, {
    callback: async (err, msg) => {
      try {
        let result;
        if (decodeJson) {
          result = await func(jsonCodec.decode(msg.data), msg);
        } else {
          result = await func(msg.data, msg);
        }
        await natsClient.publish(msg.reply, jsonCodec.encode({ result }));
      } catch (exception) {
        console.log({ exception });
        await natsClient.publish(msg.reply, jsonCodec.encode({ exception }));
      }
    }
  });
}

async function natsRequest(subject, requestData, encodeJson = true) {
  let result;
  if (encodeJson) {
    result = await natsClient.request(subject, jsonCodec.encode(requestData));
  } else {
    result = await natsClient.request(subject, requestData);
  }
  const responseData = jsonCodec.decode(result.data);
  if (responseData.exception) {
    throw responseData.exception;
  }

  return responseData.result;
}

async function cleanupSocket(connectionId) {
  console.log(`cleaning up socket ${connectionId}`);
  connections[connectionId].socket.removeAllListeners('close');
  connections[connectionId].socket.destroy();
  delete connections[connectionId];
}

async function setupConnection(connectionId, input) {
  const connection = connections[connectionId];

  const directionKey = input ? 'output' : 'input';

  connection.socket.on('data', async (data) => {
    await natsRequest(`broker-proxy.sockets.${connectionId}.${directionKey}.data`, data, false);
  });

  connection.onReceive = (data) => new Promise((resolve, reject) => {
    connection.socket.write(data, resolve);
  });

  connection.close = cleanupSocket.bind(undefined, connectionId);
  connection.socket.addListener('close', () => {
    connection.close();
    natsRequest(`broker-proxy.sockets.${connectionId}.${directionKey}.close`, {}, true);
  });
}

async function subscribeDataSubjects(input) {
  const directionKey = input ? 'input' : 'output';
  const subject = `broker-proxy.sockets.*.${directionKey}.data`;
  await setupResponder(subject, async (data, msg) => {
    const subjectParts = msg.subject.split('.');
    const connection = connections[subjectParts[2]];
    if (!connection) {
      return;
    }
    return await connection.onReceive(data);
  }, false);

  await setupResponder(`broker-proxy.sockets.*.${directionKey}.close`, (data, msg) => {
    const subjectParts = msg.subject.split('.');
    const connection = connections[subjectParts[2]];
    if (!connection) {
      return;
    }
    connection.close();
  });
}

if (args.input) {
  const server = socks.createServer(async (info, accept, deny) => {
    const connectionResult = await natsRequest('broker-proxy.open', {
      host: info.dstAddr,
      port: info.dstPort
    }).catch(deny);
    const socketId = connectionResult?.socketId;
    if (!socketId) {
      deny();
      return;
    }
    connections[socketId] = {
      socket: accept(true)
    };

    await setupConnection(socketId, true);
  });
  server.listen(1080, 'localhost');

  server.useAuth(socks.auth.None());

  await subscribeDataSubjects(true);
}

if (args.output) {
  await setupResponder('broker-proxy.open', (opts) => {
    const socket = new net.Socket();
    return new Promise((resolve, reject) => {
      socket.connect(opts);
      socket.on('connect', async (_) => {
        const socketId = socket._handle.fd;
        connections[socketId] = { socket };

        await setupConnection(socketId, false);

        resolve({ socketId });
      });
      socket.on('error', reject);
    });
  });

  await subscribeDataSubjects(false);
}