import socks from 'socksv5';
import nats, { JSONCodec } from 'nats';
import net from 'node:net';
import argparse from 'argparse';

const parser = new argparse.ArgumentParser({
  description: 'Tunnel TCP traffic via socks5 proxy through NATS'
});
parser.add_argument('-i', '--input', { help: 'Listen for incoming connections as a socks proxy. Not compatible with -o', action: 'store_true' });
parser.add_argument('-o', '--output', { help: 'Forward outgoing connections. Not compatible with -i', action: 'store_true'  });
parser.add_argument('--proxy-address', { help: 'Address to listen for incoming socks connections. Default "localhost"', default: 'localhost' });
parser.add_argument('--proxy-port', { help: 'Port to listen for incoming socks connections. Default 1080', default: 1080, type: 'int' });
parser.add_argument('-u', '--host', { help: 'NATS broker host. Default "localhost:4222"', default: 'localhost:4222' });
parser.add_argument('-t', '--token', { help: 'NATS broker token' });
parser.add_argument('-s', '--subject', { help: 'NATS subject to communicate on', required: true})

const args = parser.parse_args();

if(!(args.input ^ args.output)) {
  console.error('error: must specify either -i or -o, not both or none.');
  process.exit(1);
}

const natsClient = await nats.connect({
  servers: args.host,
  token: args.token
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
  console.log(`cleaning up socket ${connectionId}, connections: ${Object.keys(connections)}`);
  if (!connections[connectionId]) {
    console.log(`connection ${connectionId} not found`);
    return;
  }
  connections[connectionId].socket.removeAllListeners('close');
  connections[connectionId].socket.destroy();
  delete connections[connectionId];
  console.log(`cleaned up socket ${connectionId}, remaining: ${Object.keys(connections)}`);
}

async function setupConnection(connectionId, input) {
  const connection = connections[connectionId];

  console.log(`setting up socket ${connectionId}, connections: ${Object.keys(connections)}`);

  const directionKey = input ? 'output' : 'input';

  connection.socket.on('data', async (data) => {
    try {
      await natsRequest(`${args.subject}.sockets.${connectionId}.${directionKey}.data`, data, false);
    } catch (e) {
      console.log('connection error', e);
      await cleanupSocket(connectionId);
    }
  });

  connection.onReceive = (data) => new Promise((resolve, reject) => {
    try {
      connection.socket.write(data, resolve);
    } catch (e) {
      console.log('connection error');
      return cleanupSocket(connectionId);
    }
  });

  connection.close = cleanupSocket.bind(undefined, connectionId);
  connection.socket.addListener('close', () => {
    connection.close();
    natsRequest(`${args.subject}.sockets.${connectionId}.${directionKey}.close`, {}, true);
  });

  console.log(`set up socket ${connectionId}, connections: ${Object.keys(connections)}`);
}

async function subscribeDataSubjects(input) {
  const directionKey = input ? 'input' : 'output';
  const subject = `${args.subject}.sockets.*.${directionKey}.data`;
  await setupResponder(subject, async (data, msg) => {
    const subjectParts = msg.subject.split('.');
    const connection = connections[subjectParts[2]];
    if (!connection) {
      return;
    }
    return await connection.onReceive(data);
  }, false);

  await setupResponder(`${args.subject}.sockets.*.${directionKey}.close`, (data, msg) => {
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
    const connectionResult = await natsRequest(`${args.subject}.open`, {
      host: info.dstAddr,
      port: info.dstPort
    }).catch(deny);
    const socketId = connectionResult?.socketId;
    if (!socketId) {
      deny();
      return;
    }
    const socket = accept(true);
    if (!socket) {
      console.log(`error setting up socket ${socketId}`);
      return;
    }
    connections[socketId] = {
      socket
    };
    socket.on('error', console.log.bind(undefined, `Error with connection ${socketId}`));

    await setupConnection(socketId, true);
  });
  server.listen(args.proxy_port, args.proxy_address);

  server.useAuth(socks.auth.None());

  await subscribeDataSubjects(true);

  console.log('waiting for incoming connections...');
}

if (args.output) {
  await setupResponder(`${args.subject}.open`, (opts) => {
    const socket = new net.Socket();
    return new Promise((resolve, reject) => {
      socket.connect(opts);
      socket.on('connect', async (_) => {
        const socketId = socket._handle.fd;
        connections[socketId] = { socket };

        await setupConnection(socketId, false);

        resolve({ socketId });
      });

      socket.on('error', console.log.bind(undefined, `Error with connection ${socket.id}`));
    });
  });

  await subscribeDataSubjects(false);

  console.log('waiting for outgoing connections...');
}