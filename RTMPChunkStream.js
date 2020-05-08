const EventEmitter = require('events');
const RTMPChunkStreamEncoder = require('./RTMPChunkStreamEncoder');
const BufferStream = require('./BufferStream');

// Receives and sends chunks to the right chunk stream handler

class RTMPChunkStream extends EventEmitter {
  constructor() {
    super();

    this.onData.bind(this);

    this.streamStates = new Map();
    this.messageStates = new Map();
    this.chunkEncoder = new RTMPChunkStreamEncoder();
    this.newStreamState = {
      fmt: null,
      timestamp: null,
      timestampDelta: null,
      length: null,
      typeId: null,
      streamId: null,
      haveExtended: false,
    };

    this.fmtSize = {
      0: 11,
      1: 7,
      2: 3,
      3: 0,
    };

    this.streamStates.set(2, this.newStreamState);
    this.data = new BufferStream(2500000);
    this.maxChunkSize = 128;
  }

  encodeMessage(message) {
    return this.chunkEncoder.encode(message);
  }

  onData(data) {
    this.data.write(data);
    while (this.data.length > 0) {
      const basicHeader = this.parseBasicHeader();
      if (!this.streamStates.has(basicHeader.chunkStreamId)) {
        this.streamStates.set(basicHeader.chunkStreamId, this.newStreamState);
      }
      const dataRead = this.parseChunk(basicHeader);
      if (dataRead === 0) {
        break;
      }
      this.data.read(dataRead);
    }
  }

  parseBasicHeader() {
    const basicHeader = this.data.readUIntBE(0, 1);
    // First two bits
    const fmt = basicHeader >> 6;
    // Last 6 bits
    let chunkStreamId = basicHeader & 0b00111111;
    let size = 1;
    if (chunkStreamId === 0) {
      size = 2;
      // second byte + 64
      chunkStreamId = this.data.readUIntBE(1, 1) + 64;
    }
    if (chunkStreamId === 1) {
      size = 3;
      // (third byte * 256) + (second byte + 64)
      chunkStreamId = this.data.readUIntBE(1, 2);
    }

    return {
      size,
      fmt,
      chunkStreamId,
    };
  }

  updateChunkState(basicHeader) {
    const currentState = this.streamStates.get(basicHeader.chunkStreamId);
    const { fmt, chunkStreamId } = basicHeader;
    currentState.fmt = fmt;
    currentState.chunkStreamId = chunkStreamId;
    let chunkDataStart = this.fmtSize[fmt];

    // Check if data is received yet
    if (chunkDataStart > this.data.length) {
      return 0;
    }

    switch (fmt) {
      case 0: {
        let timestamp = this.data.readUIntBE(0, 3);
        // if equals to 0xFFFFFF
        if (timestamp >= 16777215) {
          chunkDataStart = 15;
          // get extended
          timestamp = this.data.readUIntBE(11, 4);
          currentState.haveExtended = true;
        } else {
          currentState.haveExtended = false;
        }
        const length = this.data.readUIntBE(3, 3);
        const typeId = this.data.readUIntBE(6, 1);
        const streamId = this.data.readUIntLE(7, 4);

        currentState.timestamp = timestamp;
        currentState.timestampDelta = 0;
        currentState.length = length;
        currentState.typeId = typeId;
        currentState.streamId = streamId;
        break;
      }
      case 1: {
        let timestampDelta = this.data.readUIntBE(0, 3);

        if (timestampDelta >= 16777215) {
          chunkDataStart = 11;
          timestampDelta = this.data.readUIntBE(7, 4);
          currentState.haveExtended = true;
        } else {
          currentState.haveExtended = false;
        }

        const length = this.data.readUIntBE(3, 3);
        const typeId = this.data.readUIntBE(6, 1);

        currentState.timestampDelta = timestampDelta;
        currentState.length = length;
        currentState.typeId = typeId;
        break;
      }
      case 2: {
        let timestampDelta = this.data.readUIntBE(0, 3);

        if (timestampDelta >= 16777215) {
          chunkDataStart = 7;
          timestampDelta = this.data.readUIntBE(3, 4);
          currentState.haveExtended = true;
        } else {
          currentState.haveExtended = false;
        }

        currentState.timestampDelta = timestampDelta;
        break;
      }
      case 3: {
        if (currentState.haveExtended) {
          chunkDataStart = 4;
          const timestampDelta = this.data.readUIntBE(0, 4);
          currentState.timestampDelta = timestampDelta;
        }
        break;
      }
    }

    const length = Math.min(currentState.length, this.maxChunkSize);
    const chunkData = this.data.slice(chunkDataStart, chunkDataStart + length);
    if (currentState.length > chunkData.length) {
      currentState.chunkData = Buffer.concat([currentState.chunkData, chunkData]);
    } else {
      currentState.chunkData = chunkData;
    }
    currentState.sizeRead = chunkDataStart + length;
    currentState.header = this.data.slice(0, chunkDataStart);
    return currentState;
  }

  parseChunk(basicHeader) {
    this.data.read(basicHeader.size);
    this.updateChunkState(basicHeader);
    const currentState = this.streamStates.get(basicHeader.chunkStreamId);
    if (currentState.length >= currentState.chunkData.length) {
      if (currentState.typeId <= 2 && basicHeader.chunkStreamId === 2 && currentState.streamId === 0) {
        this.parseProtocolControlMessage(currentState);
      } else {
        this.emit('message', currentState);
      }
    }

    return (currentState.sizeRead);
  }

  parseProtocolControlMessage(message) {
    switch (message.typeId) {
      case 1: {
        // chunks can't be larger than messages and messages can't be larger than 2^24 bytes
        const size = message.chunkData.readUIntBE(0, 4);
        this.maxChunkSize = Math.min(size, 0xFFFFFF);
        this.chunkEncoder.setMaxChunkSize(this.maxChunkSize);
        break;
      }
      case 2:
        this.streamStates.get(message.chunkStreamId).partialMessage = null;
        break;
      default:
        break;
    }
  }
}

module.exports = RTMPChunkStream;
