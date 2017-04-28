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
 * Client Interceptors
 *
 * This module describes the interceptor framework for clients.
 * An interceptor is a function which takes an options object and returns an
 * InterceptingCall:
 *
 * var interceptor = function(options) {
 *   return new InterceptingCall(options);
 * }
 *
 * The interceptor function must return an InterceptingCall object. Returning
 * `new InterceptingCall(options)` will satisfy the contract (but provide no
 * interceptor functionality).
 *
 * To implement interceptor functionality, create a requester and pass it to
 * the InterceptingCall constructor. A requester is a POJO with zero or more
 * of the following methods:
 *
 * `start(metadata, listener, next)`
 * * To continue, call next(metadata, listener). Listeners are described
 * * below.
 *
 * `sendMessage(message, next)`
 * * To continue, call next(message).
 *
 * `halfClose(next)`
 * * To continue, call next().
 *
 * `cancel(message, next)`
 * * To continue, call next().
 *
 * A listener is a POJO with one or more of the following methods:
 *
 * `onReceiveMetadata(metadata, next)`
 * * To continue, call next(metadata)
 *
 * `onReceiveMessage(message, next)`
 * * To continue, call next(message)
 *
 * `onReceiveStatus(status, next)`
 * * To continue, call next(status)
 *
 * A listener is passed into the requester's `start` method. The listener
 * implements all the inbound interceptor methods and represents the listener
 * chain constructed by any previous interceptors. Three usage patterns are
 * supported for listeners:
 * 1) Pass the listener along without modification: `next(metadata, listener)`.
 *   In this case the interceptor declines to intercept any inbound operations.
 * 2) Create a new listener with one or more inbound interceptor methods and
 *   pass it to `next`. In this case the interceptor will fire on the inbound
 *   operations implemented in the new listener.
 * 3) Store the listener to make direct inbound calls on later. This effectively
 *   short-circuits the interceptor stack.
 *
 * Do not modify the listener passed in. Either pass it along unmodified or call
 * methods on it to short-circuit the interceptor stack.
 *
 * To intercept errors, implement the `onReceiveStatus` method and test for
 * `status.code !== grpc.status.OK`.
 *
 * To intercept trailers, examine `status.metadata` in the `onReceiveStatus`
 * method.
 *
 * This is a trivial implementation of all interceptor methods:
 * var interceptor = function(options) {
 *   return new InterceptingCall(options, {
 *     start: function(metadata, listener, next) {
 *       next(metadata, {
 *         onReceiveMetadata: function (metadata, next) {
 *           next(metadata);
 *         },
 *         onReceiveMessage: function (message, next) {
 *           next(message);
 *         },
 *         onReceiveStatus: function (status, next) {
 *           next(status);
 *         },
 *       });
 *     },
 *     sendMessage: function(message, next) {
 *       next(message);
 *     },
 *     halfClose: function(next) {
 *       next();
 *     },
 *     cancel: function(message, next) {
 *       next();
 *     }
 *   });
 * };
 *
 * This is an interceptor with a single method:
 * var interceptor = function(options) {
 *   return new InterceptingCall(options, {
 *     sendMessage: function(message, next) {
 *       next(message);
 *     }
 *   });
 * };
 *
 * Builders are provided for convenience: StatusBuilder, ListenerBuilder,
 * and RequesterBuilder
 *
 * This is the mapping of the gRPC opTypes to the interceptor methods:
 *
 * grpc.opType.SEND_INITIAL_METADATA -> start
 * grpc.opType.SEND_MESSAGE -> sendMessage
 * grpc.opType.SEND_CLOSE_FROM_CLIENT -> halfClose
 * grpc.opType.RECV_INITIAL_METADATA -> onReceiveMetadata
 * grpc.opType.RECV_MESSAGE -> onReceiveMessage
 * grpc.opType.RECV_STATUS_ON_CLIENT -> onReceiveStatus
 *
 * @module
 */

'use strict';

var _ = require('lodash');
var grpc = require('./grpc_extension');

var INBOUND_OPS = [
  grpc.opType.RECV_INITIAL_METADATA,
  grpc.opType.RECV_MESSAGE,
  grpc.opType.RECV_STATUS_ON_CLIENT
];

var OUTBOUND_OPS = [
  grpc.opType.SEND_INITIAL_METADATA,
  grpc.opType.SEND_MESSAGE,
  grpc.opType.SEND_CLOSE_FROM_CLIENT
];

/**
 * A builder for gRPC status objects
 * @constructor
 */
function StatusBuilder() {
  this.code = null;
  this.details = null;
  this.metadata = null;
}

/**
 * Adds a status code to the builder
 * @param {number} code The status code
 * @returns {StatusBuilder}
 */
StatusBuilder.prototype.withCode = function(code) {
  this.code = code;
  return this;
};

/**
 * Adds details to the builder
 * @param {string} details A status message
 * @returns {StatusBuilder}
 */
StatusBuilder.prototype.withDetails = function(details) {
  this.details = details;
  return this;
};

/**
 * Adds metadata to the builder
 * @param {Metadata} metadata The gRPC status metadata
 * @returns {StatusBuilder}
 */
StatusBuilder.prototype.withMetadadta = function(metadata) {
  this.metadata = metadata;
  return this;
};

/**
 * Builds the status object
 * @returns {object} A gRPC status
 */
StatusBuilder.prototype.build = function() {
  var status = {};
  if (this.code !== undefined) {
    status.code = this.code;
  }
  if (this.details) {
    status.details = this.details;
  }
  if (this.metadata) {
    status.metadata = this.metadata;
  }
  return status;
};

/**
 * A builder for listener interceptors
 * @constructor
 */
function ListenerBuilder() {
  this.metadata = null;
  this.message = null;
  this.status = null;
}

/**
 * Adds an onReceiveMetadata method to the builder
 * @param {Function} on_receive_metadata A listener method for receiving
 * metadata
 * @returns {ListenerBuilder}
 */
ListenerBuilder.prototype.withOnReceiveMetadata =
  function(on_receive_metadata) {
    this.metadata = on_receive_metadata;
    return this;
  };

/**
 * Adds an onReceiveMessage method to the builder
 * @param {Function} on_receive_message A listener method for receiving messages
 * @returns {ListenerBuilder}
 */
ListenerBuilder.prototype.withOnReceiveMessage = function(on_receive_message) {
  this.message = on_receive_message;
  return this;
};

/**
 * Adds an onReceiveStatus method to the builder
 * @param {Function} on_receive_status A listener method for receiving status
 * @returns {ListenerBuilder}
 */
ListenerBuilder.prototype.withOnReceiveStatus = function(on_receive_status) {
  this.status = on_receive_status;
  return this;
};

/**
 * Builds the call listener
 * @returns {object}
 */
ListenerBuilder.prototype.build = function() {
  var self = this;
  var listener = {};
  listener.onReceiveMetadata = self.metadata;
  listener.onReceiveMessage = self.message;
  listener.onReceiveStatus = self.status;
  return listener;
};

/**
 * A builder for the outbound methods of an interceptor
 * @constructor
 */
function RequesterBuilder() {
  this.start = null;
  this.message = null;
  this.half_close = null;
  this.cancel = null;
}

/**
 * Add a `start` interceptor
 * @param {Function} start A requester method for handling `start`
 * @returns {RequesterBuilder}
 */
RequesterBuilder.prototype.withStart = function(start) {
  this.start = start;
  return this;
};

/**
 * Add a `sendMessage` interceptor
 * @param {Function} send_message A requester method for handling `sendMessage`
 * @returns {RequesterBuilder}
 */
RequesterBuilder.prototype.withSendMessage = function(send_message) {
  this.message = send_message;
  return this;
};

/**
 * Add a `halfClose` interceptor
 * @param {Function} half_close A requester method for handling `halfClose`
 * @returns {RequesterBuilder}
 */
RequesterBuilder.prototype.withHalfClose = function(half_close) {
  this.half_close = half_close;
  return this;
};

/**
 * Add a `cancel` interceptor
 * @param {Function} cancel A requester method for handling `cancel`
 * @returns {RequesterBuilder}
 */
RequesterBuilder.prototype.withCancel = function(cancel) {
  this.cancel = cancel;
  return this;
};

/**
 * Builds the requester's interceptor methods
 * @returns {object}
 */
RequesterBuilder.prototype.build = function() {
  var interceptor = {};
  interceptor.start = this.start;
  interceptor.sendMessage = this.message;
  interceptor.halfClose = this.half_close;
  interceptor.cancel = this.cancel;
  return interceptor;
};

/**
 * A property container for the values needed to build an interceptor chain
 * @param {InterceptingCall} next_call
 * @param {object} [requester]
 * @constructor
 */
function InterceptingCall(next_call, requester) {
  _validateRequester(requester);
  this.next_call = next_call;
  this.requester = requester;
}

InterceptingCall.prototype.pushNextCall = function(next_call) {
  if (this.next_call) {
    this.next_call.pushNextCall(next_call);
  } else {
    this.next_call = next_call;
  }
};

InterceptingCall.prototype.start = function(metadata, listener) {
  var self = this;
  _validateListener(listener);
  var next_listener = listener;
  if (listener && listener.constructor.name !== 'DelegatingListener') {
    next_listener = new DelegatingListener(listener, new TopListener());
  }
  var next_call = function(metadata, delegate) {
    var delegate_listener = _.isEqual(delegate, next_listener) ?
      null :
      delegate;
    var wrapped_listener = new DelegatingListener(delegate_listener,
      next_listener);
    self.next_call.start(metadata, wrapped_listener);
  };
  var next = self.next_call ?
    next_call :
    function(){};
  if (self.requester.start) {
    self.requester.start(metadata, next_listener, next);
  } else {
    next(metadata);
  }
};

InterceptingCall.prototype.sendMessage = function(message) {
  var next = this.next_call ?
    this.next_call.sendMessage.bind(this.next_call) :
    function(){};
  if (this.requester.sendMessage) {
    this.requester.sendMessage(message, next);
  } else {
    next(message);
  }
};

InterceptingCall.prototype.halfClose = function() {
  var next = this.next_call ?
    this.next_call.halfClose.bind(this.next_call) :
    function(){};
  if (this.requester.halfClose) {
    this.requester.halfClose(next);
  } else {
    next();
  }
};

InterceptingCall.prototype.noOp = function(context) {
  var next = this.next_call ?
    this.next_call.noOp.bind(this.next_call) :
    function(){};
  if (this.requester.noOp) {
    this.requester.noOp(context, next);
  } else {
    next(context);
  }
};

InterceptingCall.prototype.cancel = function() {
  var next = this.next_call ?
    this.next_call.cancel.bind(this.next_call) :
    function(){};
  if (this.requester.cancel) {
    this.requester.cancel(next);
  } else {
    next();
  }
};

InterceptingCall.prototype.cancelWithStatus = function(status, message) {
  var next = this.next_call ?
    this.next_call.cancelWithStatus.bind(this.next_call) :
    function(){};
  if (this.requester.cancelWithStatus) {
    this.requester.cancelWithStatus(status, message, next);
  } else {
    next(status, message);
  }
};

InterceptingCall.prototype.getPeer = function() {
  var next = this.next_call ?
    this.next_call.getPeer.bind(this.next_call) :
    function(){};
  if (this.requester.getPeer) {
    return this.requester.getPeer(next);
  } else {
    return next();
  }
};

InterceptingCall.prototype.sendMessageWithContext = function(context, message) {
  var next = this.next_call ?
    this.next_call.sendMessageWithContext.bind(this.next_call, context) :
    context;
  if (this.requester.sendMessage) {
    this.requester.sendMessage(message, next);
  } else {
    next(message);
  }
};

InterceptingCall.prototype.recvMessageWithContext = function(context) {
  var next = this.next_call ?
    this.next_call.recvMessageWithContext.bind(this.next_call, context) :
    context;
  if (this.requester.recvMessageWithContext) {
    this.requester.recvMessageWithContext(next);
  } else {
    next();
  }
};
/**
 * A custom error thrown when interceptor configuration fails
 * @param {string} message The error message
 * @param {object} [extra]
 * @constructor
 */
var InterceptorConfigurationError =
  function InterceptorConfigurationError(message, extra) {
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.message = message;
    this.extra = extra;
  };

require('util').inherits(InterceptorConfigurationError, Error);

/**
 * Checks that methods attached to an inbound interceptor match the API
 * @param {object} listener An interceptor listener
 * @private
 */
function _validateListener(listener) {
  var inbound_methods = [
    'onReceiveMetadata',
    'onReceiveMessage',
    'onReceiveStatus'
  ];
  _.forOwn(listener, function(value, key) {
    if (!_.includes(inbound_methods, key) &&
      typeof listener[key] === 'function') {
      var message = key + ' is not a valid interceptor listener method. ' +
        'Valid methods: ' + JSON.stringify(inbound_methods);
      throw new InterceptorConfigurationError(message);
    }
  });
}

/**
 * Checks that methods attached to a requester match the API
 * @param {object} requester A candidate interceptor requester
 * @private
 */
function _validateRequester(requester) {
  var outbound_methods = [
    'start',
    'sendMessage',
    'halfClose',
    'noOp',
    'cancel',
    'cancelWithStatus',
    'getPeer',
    'recvMessageWithContext'
  ];
  _.forOwn(requester, function(value, key) {
    if (!_.includes(outbound_methods, key) &&
      typeof requester[key] === 'function') {
      var message = key + ' is not a valid interceptor requester method. ' +
        'Valid methods: ' + JSON.stringify(outbound_methods);
      throw new InterceptorConfigurationError(message);
    }
  });
}

var _getInboundOps = function(ops) {
  return _.filter(ops, function(op) {
    return _.includes(INBOUND_OPS, op);
  });
};

var _getOutboundOps = function(ops) {
  return _.filter(ops, function(op) {
    return _.includes(OUTBOUND_OPS, op);
  });
};

var getInterceptingCall = function(interceptors, options) {
  var newCall = function(interceptors) {
    if (interceptors.length === 0) {
      return function(options) {};
    }
    var head_interceptor = _.head(interceptors);
    var rest_interceptors = _.tail(interceptors);
    return function(options) {
      return head_interceptor(options, newCall(rest_interceptors));
    };
  };
  var nextCall = newCall(interceptors)(options);
  return new InterceptingCall(nextCall, new TopRequester());
};

function TopRequester() {}

TopRequester.prototype.start = function(metadata, listener, next) {
  next(metadata, {
    onReceiveMetadata: function() {},
    onReceiveMessage: function() {},
    onReceiveStatus: function() {}
  });
};

TopRequester.prototype.sendMessage = function(message, next) {
  next(message);
};

TopRequester.prototype.halfClose = function(next) {
  next();
};

function TopListener() {}
TopListener.prototype.onReceiveMetadata = function(){};
TopListener.prototype.onReceiveMessage = function(){};
TopListener.prototype.onReceiveStatus = function(){};

function ForwardingListener() {}

ForwardingListener.prototype.onReceiveMetadata = function(metadata, next) {
  next(metadata);
};

ForwardingListener.prototype.onReceiveMessage = function(message, next) {
  next(message);
};

ForwardingListener.prototype.onReceiveStatus = function(status, next) {
  next(status);
};

function _joinBatches(op, op_value, ops_received, batch_registry, op_filter,
                      batcher_name, joiner, context) {
  var is_start = op === grpc.opType.SEND_INITIAL_METADATA;
  if (op !== null && op !== undefined) {
    ops_received[op] = op_value;
  }
  var ops_complete = _.map(_.keys(ops_received), function(op) {
    return parseInt(op);
  });
  var batches = batch_registry.getBatches();
  var candidate_batches = _.filter(batches, function(batch_obj) {
    return (is_start && op_filter(batch_obj.batch_ops).length === 0) ||
      _.includes(batch_obj.batch_ops, op);
  });
  var satisfied_batches = _.filter(candidate_batches, function(batch_obj) {
    var filtered_ops_required = op_filter(batch_obj.batch_ops);
    var filtered_ops_complete = _.intersection(op_filter(ops_complete),
      filtered_ops_required);
    var has_batcher = _.isFunction(batch_obj[batcher_name]);
    if (filtered_ops_required.length === 0) {
      return is_start && has_batcher && !_.isEqual(batch_obj.batch_ops,
          [grpc.opType.RECV_MESSAGE]);
    }
    return _.isEqual(filtered_ops_complete, filtered_ops_required) &&
      has_batcher;
  });
  _.each(satisfied_batches, function(batch_obj) {
    var batch_values = _.map(batch_obj.batch_ops, function(op) {
      return (ops_received[op] === null || ops_received[op] === undefined) ?
        true :
        ops_received[op];
    });
    var batch = _.zipObject(batch_obj.batch_ops, batch_values);
    joiner(batch, batch_obj[batcher_name], context);
  });
  return ops_received;
}

function _joinOperations(op, op_value, ops_received, batch_registry,
                         is_out, joiner, context) {
  var op_filter = is_out ? _getOutboundOps : _getInboundOps;
  var batcher_name = is_out ? 'outbound_batcher' : 'inbound_batcher';
  return _joinBatches(op, op_value, ops_received, batch_registry, op_filter,
    batcher_name, joiner, context);
}

function getBaseInterceptor(call_constructor, batch_registry) {
  return function(options) {
    var ops_received = {};
    var response_listener;
    var call = call_constructor(options);
    var joiner = function(batch, batcher, context) {
      batcher(batch, call, response_listener, context);
    };
    return new InterceptingCall(null, {
      start: function (metadata, listener) {
        response_listener = listener;
        var op = grpc.opType.SEND_INITIAL_METADATA;
        ops_received = _joinOutboundOperations(op, metadata, ops_received,
          batch_registry, joiner);
      },
      sendMessage: function (message, context) {
        var op = grpc.opType.SEND_MESSAGE;
        ops_received = _joinOutboundOperations(op, message, ops_received,
          batch_registry, joiner, context);
      },
      halfClose: function () {
        var op = grpc.opType.SEND_CLOSE_FROM_CLIENT;
        ops_received = _joinOutboundOperations(op, null, ops_received,
          batch_registry, joiner);
      },
      recvMessageWithContext: function(context) {
        var op = grpc.opType.RECV_MESSAGE;
        _joinBatches(op, true, ops_received, batch_registry, _getInboundOps,
          'outbound_batcher', joiner, context);
      },
      cancel: function() {
        call.cancel();
      },
      cancelWithStatus: function(status, message) {
        call.cancelWithStatus(status, message);
      },
      getPeer: function() {
        return call.getPeer();
      }
    });
  };
}

function _joinOutboundOperations(op, value, ops_received, batch_registry,
                                 joiner, context) {
  return _joinOperations(op, value, ops_received, batch_registry, true, joiner,
    context);
}

function _joinInboundOperations(op, value, ops_received, batch_registry, joiner,
                                context) {
  return _joinOperations(op, value, ops_received, batch_registry, false, joiner,
    context);
}

function getInboundBatcher(batch_registry) {
  return function(options, nextCall) {
    var ops_received = {};
    var joiner = function(batch, batcher, context) {
      batcher(batch, context);
    };
    return new InterceptingCall(nextCall(options), {
      start: function (metadata, listener, next) {
        next(metadata, {
          onReceiveMetadata: function (metadata, next) {
            var op = grpc.opType.RECV_INITIAL_METADATA;
            ops_received = _joinInboundOperations(op, metadata, ops_received,
              batch_registry, joiner);
          },
          onReceiveMessage: function (message, next, context) {
            var op = grpc.opType.RECV_MESSAGE;
            ops_received = _joinInboundOperations(op, message, ops_received,
              batch_registry, joiner, context);
          },
          onReceiveStatus: function (status, next) {
            var op = grpc.opType.RECV_STATUS_ON_CLIENT;
            ops_received = _joinInboundOperations(op, status, ops_received,
              batch_registry, joiner);
          }
        });
      }
    });
  };
}

function BatchRegistry() {
  this.batches = {};
}

BatchRegistry.prototype.add = function(name, batch_ops, outbound_batcher,
                                       inbound_batcher) {
  this.batches[name] = {
    batch_ops: batch_ops,
    outbound_batcher: outbound_batcher,
    inbound_batcher: inbound_batcher
  };
};

BatchRegistry.prototype.get = function(name) {
  return this.batches[name];
};

BatchRegistry.prototype.getBatches = function() {
  return this.batches;
};

module.exports.BatchRegistry = BatchRegistry;
module.exports.getInboundBatcher = getInboundBatcher;
module.exports.getBaseInterceptor = getBaseInterceptor;

/**
 * A listener which implements all inbound methods and delegates downstream.
 * @constructor
 */
function DelegatingListener(delegate, next_listener) {
  this.delegate = delegate || {};
  this.next_listener = next_listener;
}

/**
 * Inbound metadata receiver
 * @param {Metadata} metadata
 */
DelegatingListener.prototype.onReceiveMetadata = function(metadata) {
  if (this.delegate.onReceiveMetadata) {
    var next_method = this.next_listener ?
      this.next_listener.onReceiveMetadata.bind(this.next_listener) :
      function(){};
    this.delegate.onReceiveMetadata(metadata, next_method);
  } else {
    this.next_listener.onReceiveMetadata(metadata);
  }
};

/**
 * Inbound message receiver
 * @param {object} message
 */
DelegatingListener.prototype.onReceiveMessage = function(message) {
  if (this.delegate.onReceiveMessage) {
    var next_method = this.next_listener ?
      this.next_listener.onReceiveMessage.bind(this.next_listener) :
      function(){};
    this.delegate.onReceiveMessage(message, next_method);
  } else {
    this.next_listener.onReceiveMessage(message);
  }
};

DelegatingListener.prototype.recvMessageWithContext = function(context,
                                                               message) {
  var fallback = this.next_listener.recvMessageWithContext;
  var next_method = this.next_listener ?
    fallback.bind(this.next_listener, context) :
    context;
  if (this.delegate.onReceiveMessage) {
    this.delegate.onReceiveMessage(message, next_method, context);
  } else {
    next_method(message);
  }
};

/**
 * Inbound status receiver
 * @param {object} status
 */
DelegatingListener.prototype.onReceiveStatus = function(status) {
  if (this.delegate.onReceiveStatus) {
    var next_method = this.next_listener ?
      this.next_listener.onReceiveStatus.bind(this.next_listener) :
      function(){};
    this.delegate.onReceiveStatus(status, next_method);
  } else {
    this.next_listener.onReceiveStatus(status);
  }
};

module.exports.DelegatingListener = DelegatingListener;

/**
 * Transforms a list of interceptor providers into interceptors
 * @param {object[]} providers The interceptor providers
 * @param {MethodDescriptor} method_descriptor
 * @returns {null|function[]} An array of interceptors or null
 */
var resolveInterceptorProviders = function(providers, method_descriptor) {
  if (!_.isArray(providers)) {
    return null;
  }
  return _.flatMap(providers, function(provider) {
    if (!_.isFunction(provider.getInterceptorForMethod)) {
      throw new InterceptorConfigurationError(
        'InterceptorProviders must implement `getInterceptorForMethod`');
    }
    var interceptor = provider.getInterceptorForMethod(method_descriptor);
    return interceptor ? [interceptor] : [];
  });
};

/**
 * Resolves interceptor options at call invocation time
 * @param {object} options The call options passed to a gRPC call
 * @param {function[]} [options.interceptors] An array of interceptors
 * @param {object[]} [options.interceptor_providers] An array of providers
 * @param {MethodDescriptor} method_descriptor
 * @returns {null|function[]} The resulting interceptors
 */
var resolveInterceptorOptions = function(options, method_descriptor) {
  var provided = resolveInterceptorProviders(options.interceptor_providers,
    method_descriptor);
  var interceptor_options = [
    options.interceptors,
    provided
  ];
  var too_many_options = _.every(interceptor_options, function(interceptors) {
    return _.isArray(interceptors);
  });
  if (too_many_options) {
    throw new InterceptorConfigurationError(
      'Both interceptors and interceptor_providers were passed as options ' +
      'to the call invocation. Only one of these is allowed.');
  }
  return _.find(interceptor_options, function(interceptors) {
    return _.isArray(interceptors);
  }) || null;
};

/**
 * Chooses the first valid array of interceptors or returns null
 * @param {function[][]} interceptor_lists A list of interceptor lists in
 * descending override priority order
 * @returns {function[]|null} The resulting interceptors
 */
var resolveInterceptorOverrides = function(interceptor_lists) {
  return _.find(interceptor_lists, function(interceptor_list) {
    return _.isArray(interceptor_list);
  }) || null;
};

/**
 * Process call options and the interceptor override layers to get the final set
 * of interceptors
 * @param {object} call_options The options passed to the gRPC call
 * @param {function[]} constructor_interceptors Interceptors passed to the
 * client constructor
 * @param {MethodDescriptor} method_descriptor Details of the gRPC call method
 * @returns {Function[]|null} The final set of interceptors
 */
exports.processInterceptorLayers =
  function(call_options,
           constructor_interceptors,
           method_descriptor) {
    var calltime_interceptors = resolveInterceptorOptions(call_options,
      method_descriptor);
    var interceptor_overrides = [
      calltime_interceptors,
      constructor_interceptors
    ];
    return resolveInterceptorOverrides(interceptor_overrides);
  };

exports.resolveInterceptorProviders = resolveInterceptorProviders;
exports.InterceptingCall = InterceptingCall;
exports.ListenerBuilder = ListenerBuilder;
exports.RequesterBuilder = RequesterBuilder;
exports.StatusBuilder = StatusBuilder;
exports.InterceptorConfigurationError = InterceptorConfigurationError;
exports.getInterceptingCall = getInterceptingCall;
