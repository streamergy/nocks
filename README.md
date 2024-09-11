# nocks

Tunnel any TCP traffic through NATS via SOCKS proxies!
With one input agent and one output agent connected to the same NATS cloud you can use the input agent as a SOCKS proxy.

You <-> input agent <-> NATS broker <-> output agent <-> restricted host

## Usage
```
usage: proxy.js [-h] [-i] [-o] [--proxy-address PROXY_ADDRESS] [--proxy-port PROXY_PORT] [-u HOST]
                [-t TOKEN] -s SUBJECT

Tunnel TCP traffic via SOCKSv5 proxy through NATS

optional arguments:
  -h, --help            show this help message and exit
  -i, --input           Listen for incoming connections as a SOCKS proxy. Not compatible with -o
  -o, --output          Forward outgoing connections. Not compatible with -i
  --proxy-address PROXY_ADDRESS
                        Address to listen for incoming SOCKS connections. Default "localhost"
  --proxy-port PROXY_PORT
                        Port to listen for incoming SOCKS connections. Default 1080
  -u HOST, --host HOST  NATS broker host. Default "localhost:4222"
  -t TOKEN, --token TOKEN
                        NATS broker token
  -s SUBJECT, --subject SUBJECT
                        NATS subject to communicate on
```

A typical scenario could look like this:

### input agent
```
node proxy.js --input -subject test --host "127.0.0.1:42223" --token 654654654
```

### output agent
```
node proxy.js --output -subject test --host "127.0.0.1:42223" --token 654654654
```

This opens port 1080 on the input agent to be used as a SOCKS v5 proxy.
Whatever connection is established through said SOCKS proxy gets opened from the output agent and forwarded henceforth.