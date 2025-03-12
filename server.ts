import express from "express";
import http from "http";
import { Server } from "socket.io";
import mediasoup from "mediasoup";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors()); // Enable CORS for all origins
app.use(express.json()); // Enable JSON parsing

let worker = await mediasoup.createWorker();
let router = await worker.createRouter({
  mediaCodecs: [
    { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
    // { kind: "video", mimeType: "video/H264", clockRate: 90000 },
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  ],
});

let transports = new Map(); // Stores transports per userk
let producers = new Map(); // Stores producers per user
let consumers = new Map(); // Stores consumers per user

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on("getProducers", (callback) => {
    const activeProducers = [...producers.entries()].map(
      ([userId, producer]) => ({
        userId,
        producerId: producer.id,
      })
    );

    activeProducers.forEach((item) => {
      {
        io.emit("newStream", {
          producerId: item.producerId,
          userId: item.userId,
        });
      }
    });

    callback("reach");
  });

  // Send Router Capabilities
  socket.on("getRouterRtpCapabilities", ({ c1 }, callback) => {
    callback(router.rtpCapabilities);
  });

  // Create WebRTC Transport
  socket.on("createTransport", async ({ type }, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "127.0.0.1" }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      transports.set(socket.id, transport);

      transport.on("icestatechange", (state) => {
        console.log(`ICE state changed: ${state}`);
      });
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates, // ✅ Send ICE candidates
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error) {
      console.error("Error creating transport:", error);
      callback({ error: error.message });
    }
  });

  // Connect Transport
  socket.on(
    "connectTransport",
    async ({ transportId, dtlsParameters }, callback) => {
      console.log({
        dtlsParameters,
      });
      const transport = transports.get(socket.id);
      if (!transport) {
        console.error("Transport not found for user:", socket.id);
        return;
      }

      try {
        await transport.connect({ dtlsParameters });
        console.log("transporter is connected!!");
        callback("helllo world");
      } catch (error) {
        console.error("Transport connection failed:", error);
        callback({ error: error.message });
      }
    }
  );

  // Produce Media Stream
  socket.on(
    "produce",
    async ({ transportId, kind, rtpParameters }, callback) => {
      console.log({
        kind,
        rtpParameters,
      });
      console.log({
        codecs: rtpParameters.codecs,
      });
      const transport = transports.get(socket.id);
      if (!transport) {
        console.error("No transport found for producer:", socket.id);
        return;
      }

      console.log("Enter produced with transportId : ", transportId);

      try {
        const producer = await transport.produce({ kind, rtpParameters });
        producers.set(socket.id, producer);
        io.emit("newStream", { producerId: producer.id, userId: socket.id });
        console.log({ producerId: producer.id });
        callback(producer.id);
      } catch (error) {
        console.error("Error producing stream:", error);
        callback({ error: error.message });
      }
    }
  );

  // ✅ ADD CONSUME EVENT HANDLER
  socket.on("consume", async ({ transportId, producerId }, callback) => {
    try {
      const transport = transports.get(socket.id);
      if (!transport) {
        console.error("Consumer transport not found for user:", socket.id);
        return callback({ error: "Transport not found" });
      }

      const producer = [...producers.values()].find((p) => p.id === producerId);

      if (!producer) {
        console.error("Producer not found:", producerId);
        return callback({ error: "Producer not found" });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });

      console.log(`✅ User ${socket.id} consuming stream from ${producerId}`);
    } catch (error) {
      console.error("Error consuming stream:", error);
      callback({ error: error.message });
    }
  });

  // Stop Stream
  socket.on("stopStream", () => {
    if (producers.has(socket.id)) {
      producers.get(socket.id).close();
      producers.delete(socket.id);
      io.emit("streamStopped", { userId: socket.id });
    }
  });

  // Handle Disconnection
  socket.on("disconnect", () => {
    console.log(`User Disconnected: ${socket.id}`);

    // Close & remove producer
    if (producers.has(socket.id)) {
      producers.get(socket.id).close();
      producers.delete(socket.id);
    }

    // Close & remove consumer
    if (consumers.has(socket.id)) {
      consumers.get(socket.id).close();
      consumers.delete(socket.id);
    }

    // Close & remove transport
    if (transports.has(socket.id)) {
      transports.get(socket.id).close();
      transports.delete(socket.id);
    }
  });
});

app.get("/streams", (req, res) => {
  const activeProducers = [...producers.entries()].map(
    ([userId, producer]) => ({
      userId,
      producerId: producer.id,
    })
  );
  res.json(activeProducers);
});

server.listen(3000, () =>
  console.log("Server running on http://localhost:3000")
);
