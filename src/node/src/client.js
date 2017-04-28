/*
 *
 * Copyright 2015, Google Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */

/**
 * Client module
 *
 * This module contains the factory method for creating Client classes, and the
 * method calling code for all types of methods.
 *
 * For example, to create a client and call a method on it:
 *
 * var proto_obj = grpc.load(proto_file_path);
 * var Client = proto_obj.package.subpackage.ServiceName;
 * var client = new Client(server_address, client_credentials);
 * var call = client.unaryMethod(arguments, callback);
 *
 * @module
 */

'use strict';

var _ = require('lodash');
var arguejs = require('arguejs');

var client_interceptors = require('./client_interceptors');

var grpc = require('./grpc_extension');

var common = require('./common');

var Metadata = require('./metadata');

var EventEmitter = require('events').EventEmitter;

var stream = require('stream');

var Readable = stream.Readable;
var Writable = stream.Writable;
var Duplex = stream.Duplex;
var util = require('util');
var version = require('../../../package.json').version;

util.inherits(ClientWritableStream, Writable);

/**
 * A stream that the client can write to. Used for calls that are streaming from
 * the client side.
 * @constructor
 * @param {grpc.Call} call The call object to send data with
 * @param {function(*):Buffer=} serialize Serialization function for writes.
 */
function ClientWritableStream(call, serialize) {
  Writable.call(this, {objectMode: true});
  this.call = call;
  this.serialize = common.wrapIgnoreNull(serialize);
  this.on('finish', function() {
    call.halfClose();
  });
}

/**
 * Attempt to write the given chunk. Calls the callback when done. This is an
 * implementation of a method needed for implementing stream.Writable.
 * @access private
 * @param {Buffer} chunk The chunk to write
 * @param {string} encoding Used to pass write flags
 * @param {function(Error=)} callback Called when the write is complete
 */
function _write(chunk, encoding, callback) {
  /* jshint validthis: true */
  var context = {
    encoding: encoding,
    callback: callback
  };
  this.call.sendMessageWithContext(context, chunk);
}

ClientWritableStream.prototype._write = _write;

util.inherits(ClientReadableStream, Readable);

/**
 * A stream that the client can read from. Used for calls that are streaming
 * from the server side.
 * @constructor
 * @param {grpc.Call} call The call object to read data with
 * @param {function(Buffer):*=} deserialize Deserialization function for reads
 */
function ClientReadableStream(call, deserialize) {
  Readable.call(this, {objectMode: true});
  this.call = call;
  this.finished = false;
  this.reading = false;
  this.deserialize = common.wrapIgnoreNull(deserialize);
  /* Status generated from reading messages from the server. Overrides the
   * status from the server if not OK */
  this.read_status = null;
  /* Status received from the server. */
  this.received_status = null;
}

/**
 * Called when all messages from the server have been processed. The status
 * parameter indicates that the call should end with that status. status
 * defaults to OK if not provided.
 * @param {Object!} status The status that the call should end with
 */
function _readsDone(status) {
  /* jshint validthis: true */
  if (!status) {
    status = {code: grpc.status.OK, details: 'OK'};
  }
  if (status.code !== grpc.status.OK) {
    this.call.cancelWithStatus(status.code, status.details);
  }
  this.finished = true;
  this.read_status = status;
  this._emitStatusIfDone();
}

ClientReadableStream.prototype._readsDone = _readsDone;

/**
 * Called to indicate that we have received a status from the server.
 */
function _receiveStatus(status) {
  /* jshint validthis: true */
  this.received_status = status;
  this._emitStatusIfDone();
}

ClientReadableStream.prototype._receiveStatus = _receiveStatus;

/**
 * If we have both processed all incoming messages and received the status from
 * the server, emit the status. Otherwise, do nothing.
 */
function _emitStatusIfDone() {
  /* jshint validthis: true */
  var status;
  if (this.read_status && this.received_status) {
    if (this.read_status.code !== grpc.status.OK) {
      status = this.read_status;
    } else {
      status = this.received_status;
    }
    if (status.code === grpc.status.OK) {
      this.push(null);
    } else {
      var error = new Error(status.details);
      error.code = status.code;
      error.metadata = status.metadata;
      this.emit('error', error);
    }
    this.emit('status', status);
  }
}

ClientReadableStream.prototype._emitStatusIfDone = _emitStatusIfDone;

/**
 * Read the next object from the stream.
 * @access private
 * @param {*} size Ignored because we use objectMode=true
 */
function _read(size) {
  /* jshint validthis: true */
  var self = this;
  /**
   * Callback to be called when a READ event is received. Pushes the data onto
   * the read queue and starts reading again if applicable
   * @param {grpc.Event} event READ event object
   */
  if (self.finished) {
    self.push(null);
  } else {
    if (!self.reading) {
      self.reading = true;
      var context = {
        stream: self
      };
      self.call.recvMessageWithContext(context);
    }
  }
}

ClientReadableStream.prototype._read = _read;

util.inherits(ClientDuplexStream, Duplex);

/**
 * A stream that the client can read from or write to. Used for calls with
 * duplex streaming.
 * @constructor
 * @param {grpc.Call} call Call object to proxy
 * @param {function(*):Buffer=} serialize Serialization function for requests
 * @param {function(Buffer):*=} deserialize Deserialization function for
 *     responses
 */
function ClientDuplexStream(call, serialize, deserialize) {
  Duplex.call(this, {objectMode: true});
  this.serialize = common.wrapIgnoreNull(serialize);
  this.deserialize = common.wrapIgnoreNull(deserialize);
  this.call = call;
  /* Status generated from reading messages from the server. Overrides the
   * status from the server if not OK */
  this.read_status = null;
  /* Status received from the server. */
  this.received_status = null;
  this.on('finish', function() {
    call.halfClose();
  });
}

ClientDuplexStream.prototype._readsDone = _readsDone;
ClientDuplexStream.prototype._receiveStatus = _receiveStatus;
ClientDuplexStream.prototype._emitStatusIfDone = _emitStatusIfDone;
ClientDuplexStream.prototype._read = _read;
ClientDuplexStream.prototype._write = _write;

/**
 * Cancel the ongoing call
 */
function cancel() {
  /* jshint validthis: true */
  this.call.cancel();
}

ClientReadableStream.prototype.cancel = cancel;
ClientWritableStream.prototype.cancel = cancel;
ClientDuplexStream.prototype.cancel = cancel;

/**
 * Get the endpoint this call/stream is connected to.
 * @return {string} The URI of the endpoint
 */
function getPeer() {
  /* jshint validthis: true */
  return this.call.getPeer();
}

ClientReadableStream.prototype.getPeer = getPeer;
ClientWritableStream.prototype.getPeer = getPeer;
ClientDuplexStream.prototype.getPeer = getPeer;

var MethodType = {
  UNARY: 0,
  CLIENT_STREAMING: 1,
  SERVER_STREAMING: 2,
  BIDI_STREAMING: 3
};

exports.MethodType = MethodType;

/**
 * A container for the useful properties of a gRPC method.
 * @param {string} name
 * @param {string} service_name
 * @param {string} path
 * @param {MethodType} method_type
 * @param {Function} serialize
 * @param {Function} deserialize
 * @constructor
 */
function MethodDescriptor(name, service_name, path, method_type, serialize,
                          deserialize) {
  this.name = name;
  this.service_name = service_name;
  this.path = path;
  this.method_type = method_type;
  this.serialize = serialize;
  this.deserialize = deserialize;
}

exports.MethodDescriptor = MethodDescriptor;

/**
 * Get a call object built with the provided options. Keys for options are
 * 'deadline', which takes a date or number, and 'host', which takes a string
 * and overrides the hostname to connect to.
 * @param {grpc.Channel} channel
 * @param {Object} options Options map.
 */
function getCall(channel, options) {
  var deadline;
  var host;
  var parent;
  var propagate_flags;
  var credentials;
  var method_descriptor;
  if (options) {
    deadline = options.deadline;
    host = options.host;
    parent = _.get(options, 'parent.call');
    propagate_flags = options.propagate_flags;
    credentials = options.credentials;
    method_descriptor = options.method_descriptor;
  }
  if (deadline === undefined) {
    deadline = Infinity;
  }
  var call = new grpc.Call(channel, method_descriptor.path, deadline, host,
    parent, propagate_flags);
  if (credentials) {
    call.setCredentials(credentials);
  }
  return call;
}

var BatchType = {
  UNARY: 0,
  METADATA: 1,
  CLOSE: 2,
  SEND_STREAMING: 3,
  RECV_STREAMING: 4,
  STATUS: 5,
  SEND_SYNC: 6,
  RECV_SYNC: 7
};

function _getInterceptingCall(call_constructor, interceptors, batch_registry,
                              options) {
  var interceptor_base = client_interceptors.getBaseInterceptor(
    call_constructor, batch_registry);
  var interceptor_top = client_interceptors.getInboundBatcher(batch_registry);
  var all_interceptors = _.concat(interceptor_top, interceptors,
    interceptor_base);
  return client_interceptors.getInterceptingCall(all_interceptors, options);
}

function _registerUnaryBatch(emitter, batch_registry, options, callback) {
  var join_top = function(batch) {
    var metadata = batch[grpc.opType.RECV_INITIAL_METADATA];
    var message = batch[grpc.opType.RECV_MESSAGE];
    var status = batch[grpc.opType.RECV_STATUS_ON_CLIENT];
    var error;
    emitter.emit('metadata', metadata);
    if (status.code !== grpc.status.OK) {
      error = new Error(status.details);
      error.code = status.code;
      error.metadata = status.metadata;
      callback(error);
    } else {
      callback(null, message);
    }
    emitter.emit('status', status);
  };

  var join_base = function(batch, call, listener) {
    var raw_message = batch[grpc.opType.SEND_MESSAGE];
    var message = options.method_descriptor.serialize(raw_message);
    if (options) {
      message.grpcWriteFlags = options.flags;
    }
    var raw_metadata = batch[grpc.opType.SEND_INITIAL_METADATA];
    var metadata = raw_metadata._getCoreRepresentation();
    batch[grpc.opType.SEND_MESSAGE] = message;
    batch[grpc.opType.SEND_INITIAL_METADATA] = metadata;
    call.startBatch(batch, function(err, response) {
      response.status.metadata = Metadata._fromCoreRepresentation(
        response.status.metadata);
      var status = response.status;
      var deserialized;
      if (status.code === grpc.status.OK) {
        if (err) {
          // Got a batch error, but OK status. Something went wrong
          callback(err);
          return;
        } else {
          try {
            deserialized = options.method_descriptor.deserialize(response.read);
          } catch (e) {
            /* Change status to indicate bad server response. This will result
             * in passing an error to the callback */
            status = {
              code: grpc.status.INTERNAL,
              details: 'Failed to parse server response'
            };
          }
        }
      }
      response.metadata = Metadata._fromCoreRepresentation(response.metadata);
      listener.onReceiveMetadata(response.metadata);
      listener.onReceiveMessage(deserialized);
      listener.onReceiveStatus(status);
    });
  };

  var batch_ops = [
    grpc.opType.SEND_INITIAL_METADATA,
    grpc.opType.SEND_MESSAGE,
    grpc.opType.SEND_CLOSE_FROM_CLIENT,
    grpc.opType.RECV_INITIAL_METADATA,
    grpc.opType.RECV_MESSAGE,
    grpc.opType.RECV_STATUS_ON_CLIENT
  ];

  batch_registry.add('unary', batch_ops, join_base, join_top);
}

function _registerMetadataBatch(emitter, batch_registry) {

  var join_top = function(batch) {
    var metadata = batch[grpc.opType.RECV_INITIAL_METADATA];
    emitter.emit('metadata', metadata);
  };

  var join_base = function(batch, call, listener) {
    var metadata_batch = {};
    var raw_metadata = batch[grpc.opType.SEND_INITIAL_METADATA];
    var metadata = raw_metadata._getCoreRepresentation();
    metadata_batch[grpc.opType.SEND_INITIAL_METADATA] = metadata;
    metadata_batch[grpc.opType.RECV_INITIAL_METADATA] = true;
    call.startBatch(metadata_batch, function(err, response) {
      if (err) {
        // The call has stopped for some reason. A non-OK status will arrive
        // in the other batch.
        return;
      }
      response.metadata = Metadata._fromCoreRepresentation(response.metadata);
      listener.onReceiveMetadata(response.metadata);
    });
  };

  var batch_ops = [
    grpc.opType.SEND_INITIAL_METADATA,
    grpc.opType.RECV_INITIAL_METADATA
  ];

  batch_registry.add('metadata', batch_ops, join_base, join_top);
}

function _registerRecvSync(emitter, batch_registry, options, callback) {
  var join_top = function(batch) {
    var message = batch[grpc.opType.RECV_MESSAGE];
    var status = batch[grpc.opType.RECV_STATUS_ON_CLIENT];
    var error;
    if (status.code !== grpc.status.OK) {
      error = new Error(status.details);
      error.code = status.code;
      error.metadata = status.metadata;
      callback(error);
    } else {
      callback(null, message);
    }
    emitter.emit('status', status);
  };

  var join_base = function(batch, call, listener) {
    var client_batch = {};
    client_batch[grpc.opType.RECV_MESSAGE] = true;
    client_batch[grpc.opType.RECV_STATUS_ON_CLIENT] = true;
    call.startBatch(client_batch, function(err, response) {
      response.status.metadata = Metadata._fromCoreRepresentation(
        response.status.metadata);
      var status = response.status;
      var deserialized;
      if (status.code === grpc.status.OK) {
        if (err) {
          // Got a batch error, but OK status. Something went wrong
          callback(err);
          return;
        } else {
          try {
            deserialized = options.method_descriptor.deserialize(response.read);
          } catch (e) {
            /* Change status to indicate bad server response. This will result
             * in passing an error to the callback */
            status = {
              code: grpc.status.INTERNAL,
              details: 'Failed to parse server response'
            };
          }
        }
      }
      listener.onReceiveMessage(deserialized);
      listener.onReceiveStatus(status);
    });
  };

  var batch_ops = [
    grpc.opType.RECV_MESSAGE,
    grpc.opType.RECV_STATUS_ON_CLIENT
  ];
  batch_registry.add('recv_sync', batch_ops, join_base, join_top);
}

function _registerSendStreaming(emitter, batch_registry, options) {

  var join_base = function(batch, call, listener, context) {
    var message;
    var chunk = batch[grpc.opType.SEND_MESSAGE];
    var callback = context.callback;
    var encoding = context.encoding;
    try {
      message = options.method_descriptor.serialize(chunk);
    } catch (e) {
      /* Sending this error to the server and emitting it immediately on the
       client may put the call in a slightly weird state on the client side,
       but passing an object that causes a serialization failure is a misuse
       of the API anyway, so that's OK. The primary purpose here is to give the
       programmer a useful error and to stop the stream properly */
      call.cancelWithStatus(grpc.status.INTERNAL, 'Serialization failure');
      if (callback) {
        callback(e);
      }
    }
    if (_.isFinite(encoding)) {
      /* Attach the encoding if it is a finite number. This is the closest we
       * can get to checking that it is valid flags */
      message.grpcWriteFlags = encoding;
    } else {
      message.grpcWriteFlags = options.flags;
    }
    var streaming_batch = {};
    streaming_batch[grpc.opType.SEND_MESSAGE] = message;
    call.startBatch(streaming_batch, function(err, event) {
      if (err) {
        // Something has gone wrong. Stop writing by failing to call callback
        return;
      }
      if (callback) {
        callback();
      }
    });
  };
  var batch_ops = [
    grpc.opType.SEND_MESSAGE
  ];

  batch_registry.add('send_streaming', batch_ops, join_base);
}

function _registerClose(emitter, batch_registry) {
  var join_base = function(batch, call) {
    var end_batch = {};
    end_batch[grpc.opType.SEND_CLOSE_FROM_CLIENT] = true;
    call.startBatch(end_batch, function() {});
  };

  var batch_ops = [
    grpc.opType.SEND_CLOSE_FROM_CLIENT
  ];

  batch_registry.add('close', batch_ops, join_base);
}

function _registerSendSync(emitter, batch_registry, options) {

  var join_top = function(batch) {
    var metadata = batch[grpc.opType.RECV_INITIAL_METADATA];
    emitter.emit('metadata', metadata);
  };

  var join_base = function(batch, call, listener) {
    var start_batch = {};
    var raw_message = batch[grpc.opType.SEND_MESSAGE];
    var message = options.method_descriptor.serialize(raw_message);
    if (options) {
      message.grpcWriteFlags = options.flags;
    }
    var raw_metadata = batch[grpc.opType.SEND_INITIAL_METADATA];
    var metadata = raw_metadata._getCoreRepresentation();
    start_batch[grpc.opType.SEND_INITIAL_METADATA] = metadata;
    start_batch[grpc.opType.SEND_MESSAGE] = message;
    start_batch[grpc.opType.SEND_CLOSE_FROM_CLIENT] = true;
    start_batch[grpc.opType.RECV_INITIAL_METADATA] = true;
    call.startBatch(start_batch, function(err, response) {
      if (err) {
        // The call has stopped for some reason. A non-OK status will arrive
        // in the other batch.
        return;
      }
      response.metadata = Metadata._fromCoreRepresentation(response.metadata);
      listener.onReceiveMetadata(response.metadata);
    });
  };

  var batch_ops = [
    grpc.opType.SEND_INITIAL_METADATA,
    grpc.opType.RECV_INITIAL_METADATA,
    grpc.opType.SEND_MESSAGE,
    grpc.opType.SEND_CLOSE_FROM_CLIENT
  ];

  batch_registry.add('send_sync', batch_ops, join_base, join_top);
}

function _registerStatus(emitter, batch_registry) {
  var join_top = function(batch) {
    var status = batch[grpc.opType.RECV_STATUS_ON_CLIENT];
    emitter._receiveStatus(status);
  };

  var join_base = function(batch, call, listener) {
    var status_batch = {};
    status_batch[grpc.opType.RECV_STATUS_ON_CLIENT] = true;
    call.startBatch(status_batch, function(err, response) {
      if (err) {
        emitter.emit('error', err);
        return;
      }
      response.status.metadata = Metadata._fromCoreRepresentation(
        response.status.metadata);
      listener.onReceiveStatus(response.status);
    });
  };

  var batch_ops = [
    grpc.opType.RECV_STATUS_ON_CLIENT
  ];

  batch_registry.add('status', batch_ops, join_base, join_top);
}

function _registerRecvStreaming(emitter, batch_registry, options) {
  var getCallback = function(stream, call, listener) {
    return function(err, response) {
      if (err) {
        // Something has gone wrong. Stop reading and wait for status
        stream.finished = true;
        stream._readsDone();
        return;
      }
      var context = {
        stream: stream,
        call: call,
        listener: listener
      };
      var data = response.read;
      var deserialized;
      try {
        deserialized = options.method_descriptor.deserialize(data);
      } catch (e) {
        stream._readsDone({code: grpc.status.INTERNAL,
          details: 'Failed to parse server response'});
        return;
      }
      if (data === null) {
        stream._readsDone();
        return;
      }
      listener.recvMessageWithContext(context, deserialized);
    };
  };
  var join_top = function(batch, context) {
    var message = batch[grpc.opType.RECV_MESSAGE];
    var stream_obj = context.stream;
    var call = context.call;
    var listener = context.listener;
    if (stream_obj.push(message) && message !== null) {
      var read_batch = {};
      read_batch[grpc.opType.RECV_MESSAGE] = true;
      call.startBatch(read_batch, getCallback(context.stream, call, listener));
    } else {
      stream_obj.reading = false;
    }
  };

  var join_base = function(batch, call, listener, context) {
    context.call = call;
    context.listener = listener;
    var read_batch = {};
    read_batch[grpc.opType.RECV_MESSAGE] = true;
    call.startBatch(read_batch, getCallback(context.stream, call, listener));
  };

  var batch_ops = [
    grpc.opType.RECV_MESSAGE
  ];

  batch_registry.add('recv_streaming', batch_ops, join_base, join_top);
}

function _registerBatches(emitter, batch_registry, batch_types, options,
                          callback) {
  var actions = {};
  actions[BatchType.UNARY] = _registerUnaryBatch;
  actions[BatchType.METADATA] = _registerMetadataBatch;
  actions[BatchType.RECV_SYNC] = _registerRecvSync;
  actions[BatchType.SEND_STREAMING] = _registerSendStreaming;
  actions[BatchType.CLOSE] = _registerClose;
  actions[BatchType.SEND_SYNC] = _registerSendSync;
  actions[BatchType.STATUS] = _registerStatus;
  actions[BatchType.RECV_STREAMING] = _registerRecvStreaming;

  _.each(batch_types, function(batch_type) {
    actions[batch_type](emitter, batch_registry, options, callback);
  });
}

/**
 * Get a function that can make unary requests to the specified method.
 * @param {MethodDescriptor} method_descriptor A container of method attributes
 * creation of the request method
 * @return {Function} makeUnaryRequest
 */
function makeUnaryRequestFunction(method_descriptor) {
  /**
   * Make a unary request with this method on the given channel with the given
   * argument, callback, etc.
   * @this {Client} Client object. Must have a channel member.
   * @param {*} argument The argument to the call. Should be serializable with
   *     serialize
   * @param {Metadata=} metadata Metadata to add to the call
   * @param {Object=} options Options map
   * @param {function(?Error, value=)} callback The callback to for when the
   *     response is received
   * @return {EventEmitter} An event emitter for stream related events
   */
  function makeUnaryRequest(argument, metadata, options, callback) {
    /* jshint validthis: true */
    /* While the arguments are listed in the function signature, those variables
     * are not used directly. Instead, ArgueJS processes the arguments
     * object. This allows for simple handling of optional arguments in the
     * middle of the argument list, and also provides type checking. */
    var args = arguejs({argument: null, metadata: [Metadata, new Metadata()],
      options: [Object, {}], callback: Function}, arguments);
    var emitter = new EventEmitter();
    var constructor_interceptors = this[method_descriptor.name] ?
      this[method_descriptor.name].interceptors :
      null;
    args.options.method_descriptor = method_descriptor;
    var call_constructor = getCall.bind(null, this.$channel);
    metadata = args.metadata.clone();
    var interceptors = client_interceptors.processInterceptorLayers(
      args.options,
      constructor_interceptors,
      method_descriptor
    );

    var batch_registry = new client_interceptors.BatchRegistry();
    var intercepting_call = _getInterceptingCall(call_constructor,
      interceptors, batch_registry, args.options);
    _registerBatches(emitter, batch_registry, [BatchType.UNARY], args.options,
      args.callback);

    emitter.cancel = function cancel() {
      intercepting_call.cancel();
    };
    emitter.getPeer = function getPeer() {
      return intercepting_call.getPeer();
    };

    intercepting_call.start(metadata);
    intercepting_call.sendMessage(args.argument);
    intercepting_call.halfClose();

    return emitter;
  }
  return makeUnaryRequest;
}

/**
 * Get a function that can make client stream requests to the specified method.
 * @param {MethodDescriptor} method_descriptor A container of method attributes
 * @return {Function} makeClientStreamRequest
 */
function makeClientStreamRequestFunction(method_descriptor) {
  /**
   * Make a client stream request with this method on the given channel with the
   * given callback, etc.
   * @this {Client} Client object. Must have a channel member.
   * @param {Metadata=} metadata Array of metadata key/value pairs to add to the
   *     call
   * @param {Object=} options Options map
   * @param {function(?Error, value=)} callback The callback to for when the
   *     response is received
   * @return {EventEmitter} An event emitter for stream related events
   */
  function makeClientStreamRequest(metadata, options, callback) {
    /* jshint validthis: true */
    /* While the arguments are listed in the function signature, those variables
     * are not used directly. Instead, ArgueJS processes the arguments
     * object. This allows for simple handling of optional arguments in the
     * middle of the argument list, and also provides type checking. */
    var args = arguejs({metadata: [Metadata, new Metadata()],
      options: [Object, {}], callback: Function}, arguments);
    var constructor_interceptors = this[method_descriptor.name] ?
      this[method_descriptor.name].interceptors :
      null;
    args.options.method_descriptor = method_descriptor;
    var interceptors = client_interceptors.processInterceptorLayers(
      args.options,
      constructor_interceptors,
      method_descriptor
    );
    var call_constructor = getCall.bind(null, this.$channel);
    metadata = args.metadata.clone();

    var batch_registry = new client_interceptors.BatchRegistry();
    var intercepting_call = _getInterceptingCall(call_constructor,
      interceptors, batch_registry, args.options);
    var emitter = new ClientWritableStream(intercepting_call,
      method_descriptor.serialize);

    var batch_types = [
      BatchType.METADATA,
      BatchType.RECV_SYNC,
      BatchType.SEND_STREAMING,
      BatchType.CLOSE
    ];
    _registerBatches(emitter, batch_registry, batch_types, args.options,
      args.callback);

    intercepting_call.start(metadata);

    return emitter;
  }
  return makeClientStreamRequest;
}

/**
 * Get a function that can make server stream requests to the specified method.
 * @param {MethodDescriptor} method_descriptor A container of method attributes
 * creation of the request method
 * @return {Function} makeServerStreamRequest
 */
function makeServerStreamRequestFunction(method_descriptor) {
  /**
   * Make a server stream request with this method on the given channel with the
   * given argument, etc.
   * @this {SurfaceClient} Client object. Must have a channel member.
   * @param {*} argument The argument to the call. Should be serializable with
   *     serialize
   * @param {Metadata=} metadata Array of metadata key/value pairs to add to the
   *     call
   * @param {Object} options Options map
   * @return {EventEmitter} An event emitter for stream related events
   */
  function makeServerStreamRequest(argument, metadata, options) {
    /* jshint validthis: true */
    /* While the arguments are listed in the function signature, those variables
     * are not used directly. Instead, ArgueJS processes the arguments
     * object. */
    var args = arguejs({argument: null, metadata: [Metadata, new Metadata()],
      options: [Object, {}]}, arguments);
    var constructor_interceptors = this[method_descriptor.name] ?
      this[method_descriptor.name].interceptors :
      null;
    args.options.method_descriptor = method_descriptor;
    var interceptors = client_interceptors.processInterceptorLayers(
      args.options,
      constructor_interceptors,
      method_descriptor
    );
    var call_constructor = getCall.bind(null, this.$channel);
    metadata = args.metadata.clone();
    var batch_registry = new client_interceptors.BatchRegistry();
    var intercepting_call = _getInterceptingCall(call_constructor,
      interceptors, batch_registry, args.options);

    var batch_types = [
      BatchType.SEND_SYNC,
      BatchType.STATUS,
      BatchType.RECV_STREAMING
    ];

    var emitter = new ClientReadableStream(intercepting_call,
      method_descriptor.deserialize);
    _registerBatches(emitter, batch_registry, batch_types, args.options,
      args.callback);
    intercepting_call.start(metadata);
    intercepting_call.sendMessage(args.argument);
    intercepting_call.halfClose();
    return emitter;
  }
  return makeServerStreamRequest;
}

/**
 * Get a function that can make bidirectional stream requests to the specified
 * method.
 * @param {MethodDescriptor} method_descriptor A container of method attributes
 * @param {grpc.Client} [client] A client object to attach the function to
 * @param {Function[]} [method_interceptors] Interceptors provided during
 * creation of the request method
 * @return {Function} makeBidiStreamRequest
 */
function makeBidiStreamRequestFunction(method_descriptor) {
  /**
   * Make a bidirectional stream request with this method on the given channel.
   * @this {SurfaceClient} Client object. Must have a channel member.
   * @param {Metadata=} metadata Array of metadata key/value pairs to add to the
   *     call
   * @param {Options} options Options map
   * @return {EventEmitter} An event emitter for stream related events
   */
  function makeBidiStreamRequest(metadata, options) {
    /* jshint validthis: true */
    /* While the arguments are listed in the function signature, those variables
     * are not used directly. Instead, ArgueJS processes the arguments
     * object. */
    var args = arguejs({metadata: [Metadata, new Metadata()],
      options: [Object, {}]}, arguments);
    var constructor_interceptors = this[method_descriptor.name] ?
      this[method_descriptor.name].interceptors :
      null;
    args.options.method_descriptor = method_descriptor;
    var interceptors = client_interceptors.processInterceptorLayers(
      args.options,
      constructor_interceptors,
      method_descriptor
    );
    var call_constructor = getCall.bind(null, this.$channel);
    metadata = args.metadata.clone();
    var batch_registry = new client_interceptors.BatchRegistry();
    var intercepting_call = _getInterceptingCall(call_constructor,
      interceptors, batch_registry, args.options);

    var batch_types = [
      BatchType.METADATA,
      BatchType.STATUS,
      BatchType.SEND_STREAMING,
      BatchType.RECV_STREAMING,
      BatchType.CLOSE
    ];

    var emitter = new ClientDuplexStream(intercepting_call,
      method_descriptor.serialize, method_descriptor.deserialize);
    _registerBatches(emitter, batch_registry, batch_types, args.options,
      args.callback);
    intercepting_call.start(metadata);
    return emitter;
  }
  return makeBidiStreamRequest;
}


/**
 * Map with short names for each of the requester maker functions. Used in
 * makeClientConstructor
 */
var requester_makers = {};
requester_makers[MethodType.UNARY] = makeUnaryRequestFunction;
requester_makers[MethodType.CLIENT_STREAMING] = makeClientStreamRequestFunction;
requester_makers[MethodType.SERVER_STREAMING] = makeServerStreamRequestFunction;
requester_makers[MethodType.BIDI_STREAMING] = makeBidiStreamRequestFunction;

function getDefaultValues(metadata, options) {
  var res = {};
  res.metadata = metadata || new Metadata();
  res.options = options || {};
  return res;
}

/**
 * Map with wrappers for each type of requester function to make it use the old
 * argument order with optional arguments after the callback.
 */
var deprecated_request_wrap = {
  unary: function(makeUnaryRequest) {
    return function makeWrappedUnaryRequest(argument, callback,
                                            metadata, options) {
      /* jshint validthis: true */
      var opt_args = getDefaultValues(metadata, metadata);
      return makeUnaryRequest.call(this, argument, opt_args.metadata,
        opt_args.options, callback);
    };
  },
  client_stream: function(makeServerStreamRequest) {
    return function makeWrappedClientStreamRequest(callback, metadata,
                                                   options) {
      /* jshint validthis: true */
      var opt_args = getDefaultValues(metadata, options);
      return makeServerStreamRequest.call(this, opt_args.metadata,
        opt_args.options, callback);
    };
  },
  server_stream: _.identity,
  bidi: _.identity
};

exports.InterceptorProvider = function(get_interceptor) {
  this.get_interceptor = get_interceptor;
};

exports.InterceptorProvider.prototype.getInterceptorForMethod =
  function(method_descriptor) {
    return this.get_interceptor(method_descriptor);
  };

/**
 * Creates a constructor for a client with the given methods. The methods object
 * maps method name to an object with the following keys:
 * path: The path on the server for accessing the method. For example, for
 *     protocol buffers, we use "/service_name/method_name"
 * requestStream: bool indicating whether the client sends a stream
 * resonseStream: bool indicating whether the server sends a stream
 * requestSerialize: function to serialize request objects
 * responseDeserialize: function to deserialize response objects
 * @param {Object} methods An object mapping method names to method attributes
 * @param {string} serviceName The fully qualified name of the service
 * @param {Object} class_options An options object. Currently only uses the key
 *     deprecatedArgumentOrder, a boolean that Indicates that the old argument
 *     order should be used for methods, with optional arguments at the end
 *     instead of the callback at the end. Defaults to false. This option is
 *     only a temporary stopgap measure to smooth an API breakage.
 *     It is deprecated, and new code should not use it.
 * @return {function(string, Object)} New client constructor
 */
exports.makeClientConstructor = function(methods, serviceName,
                                         class_options) {
  if (!class_options) {
    class_options = {};
  }
  /**
   * Create a client with the given methods
   * @constructor
   * @param {string} address The address of the server to connect to
   * @param {grpc.Credentials} credentials Credentials to use to connect
   *     to the server
   * @param {Object} options Options to pass to the underlying channel
   */
  function Client(address, credentials, options) {
    var self = this;
    if (!options) {
      options = {};
    }
    /* Append the grpc-node user agent string after the application user agent
     * string, and put the combination at the beginning of the user agent string
     */
    if (options['grpc.primary_user_agent']) {
      options['grpc.primary_user_agent'] += ' ';
    } else {
      options['grpc.primary_user_agent'] = '';
    }
    options['grpc.primary_user_agent'] += 'grpc-node/' + version;

    /* Resolve interceptor options and assign interceptors to each method */
    var interceptor_providers = options.interceptor_providers || [];
    delete options.interceptor_providers;
    var interceptors = options.interceptors || [];
    delete options.interceptors;
    if (interceptor_providers.length && interceptors.length) {
      throw new client_interceptors.InterceptorConfigurationError(
        'Both interceptors and interceptor_providers were passed as options ' +
        'to the client constructor. Only one of these is allowed.');
    }
    _.each(self.$method_descriptors, function(method_descriptor) {
      self[method_descriptor.name].interceptors = client_interceptors
        .resolveInterceptorProviders(interceptor_providers, method_descriptor)
        .concat(interceptors);
    });

    /* Private fields use $ as a prefix instead of _ because it is an invalid
     * prefix of a method name */
    self.$channel = new grpc.Channel(address, credentials, options);

  }
  _.each(methods, function(attrs, name) {
    var method_type;
    if (_.startsWith(name, '$')) {
      throw new Error('Method names cannot start with $');
    }
    if (attrs.requestStream) {
      if (attrs.responseStream) {
        method_type = MethodType.BIDI_STREAMING;
      } else {
        method_type = MethodType.CLIENT_STREAMING;
      }
    } else {
      if (attrs.responseStream) {
        method_type = MethodType.SERVER_STREAMING;
      } else {
        method_type = MethodType.UNARY;
      }
    }
    var serialize = attrs.requestStream ?
      common.wrapIgnoreNull(attrs.requestSerialize) :
      attrs.requestSerialize;
    var deserialize = attrs.responseStream ?
      common.wrapIgnoreNull(attrs.responseDeserialize) :
      attrs.responseDeserialize;
    var service_name = attrs.path.split('/')[1];
    var method_descriptor = new MethodDescriptor(name, service_name, attrs.path,
      method_type, serialize, deserialize);
    var method_func = requester_makers[method_type](method_descriptor);
    if (class_options.deprecatedArgumentOrder) {
      Client.prototype[name] = deprecated_request_wrap(method_func);
    } else {
      Client.prototype[name] = method_func;
    }
    if (!_.isArray(Client.prototype.$method_descriptors)) {
      Client.prototype.$method_descriptors = [];
    }
    Client.prototype.$method_descriptors.push(method_descriptor);
    // Associate all provided attributes with the method
    _.assign(Client.prototype[name], attrs);
  });

  return Client;
};

/**
 * Return the underlying channel object for the specified client
 * @param {Client} client
 * @return {Channel} The channel
 */
exports.getClientChannel = function(client) {
  return client.$channel;
};

/**
 * Gets a map of client methods to interceptor arrays
 * @param {object} client
 * @returns {object}
 */
exports.getClientInterceptors = function(client) {
  return _.mapValues(_.keyBy(client.$method_descriptors, 'name'),
    function(d, name) {
      return client[name].interceptors;
    });
};

/**
 * Wait for the client to be ready. The callback will be called when the
 * client has successfully connected to the server, and it will be called
 * with an error if the attempt to connect to the server has unrecoverablly
 * failed or if the deadline expires. This function will make the channel
 * start connecting if it has not already done so.
 * @param {Client} client The client to wait on
 * @param {(Date|Number)} deadline When to stop waiting for a connection. Pass
 *     Infinity to wait forever.
 * @param {function(Error)} callback The callback to call when done attempting
 *     to connect.
 */
exports.waitForClientReady = function(client, deadline, callback) {
  var checkState = function(err) {
    if (err) {
      callback(new Error('Failed to connect before the deadline'));
      return;
    }
    var new_state = client.$channel.getConnectivityState(true);
    if (new_state === grpc.connectivityState.READY) {
      callback();
    } else if (new_state === grpc.connectivityState.FATAL_FAILURE) {
      callback(new Error('Failed to connect to server'));
    } else {
      client.$channel.watchConnectivityState(new_state, deadline, checkState);
    }
  };
  checkState();
};

/**
 * Creates a constructor for clients for the given service
 * @param {ProtoBuf.Reflect.Service} service The service to generate a client
 *     for
 * @param {Object=} options Options to apply to the client
 * @return {function(string, Object)} New client constructor
 */
exports.makeProtobufClientConstructor =  function(service, options) {
  var method_attrs = common.getProtobufServiceAttrs(service, options);
  var deprecatedArgumentOrder = false;
  if (!options) {
    options = {deprecatedArgumentOrder: false};
  }
  var Client = exports.makeClientConstructor(
      method_attrs, common.fullyQualifiedName(service),
      deprecatedArgumentOrder);
  Client.service = service;
  Client.service.grpc_options = options;
  return Client;
};

/**
 * Map of status code names to status codes
 */
exports.status = grpc.status;

/**
 * See docs for client.callError
 */
exports.callError = grpc.callError;

exports.StatusBuilder = client_interceptors.StatusBuilder;
exports.ListenerBuilder = client_interceptors.ListenerBuilder;
exports.RequesterBuilder = client_interceptors.RequesterBuilder;
exports.InterceptingCall = client_interceptors.InterceptingCall;
exports.DelegatingListener = client_interceptors.DelegatingListener;
