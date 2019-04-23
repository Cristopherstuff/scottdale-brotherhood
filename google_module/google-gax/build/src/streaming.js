"use strict";
/**
 * Copyright 2016, Google Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above
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
 */
Object.defineProperty(exports, "__esModule", { value: true });
const warnings_1 = require("./warnings");
const duplexify = require('duplexify');
const retryRequest = require('retry-request');
/**
 * The type of gRPC streaming.
 * @enum {number}
 */
var StreamType;
(function (StreamType) {
    /** Client sends a single request, server streams responses. */
    StreamType[StreamType["SERVER_STREAMING"] = 1] = "SERVER_STREAMING";
    /** Client streams requests, server returns a single response. */
    StreamType[StreamType["CLIENT_STREAMING"] = 2] = "CLIENT_STREAMING";
    /** Both client and server stream objects. */
    StreamType[StreamType["BIDI_STREAMING"] = 3] = "BIDI_STREAMING";
})(StreamType = exports.StreamType || (exports.StreamType = {}));
class StreamProxy extends duplexify {
    /**
     * StreamProxy is a proxy to gRPC-streaming method.
     *
     * @private
     * @constructor
     * @param {StreamType} type - the type of gRPC stream.
     * @param {ApiCallback} callback - the callback for further API call.
     */
    constructor(type, callback) {
        super(undefined, undefined, {
            objectMode: true,
            readable: type !== StreamType.CLIENT_STREAMING,
            writable: type !== StreamType.SERVER_STREAMING,
        });
        this.type = type;
        this._callback = callback;
        this._isCancelCalled = false;
    }
    cancel() {
        if (this.stream) {
            this.stream.cancel();
        }
        else {
            this._isCancelCalled = true;
        }
    }
    /**
     * Forward events from an API request stream to the user's stream.
     * @param {Stream} stream - The API request stream.
     */
    forwardEvents(stream) {
        const eventsToForward = ['metadata', 'response', 'status'];
        eventsToForward.forEach(event => {
            stream.on(event, this.emit.bind(this, event));
        });
        // We also want to supply the status data as 'response' event to support
        // the behavior of google-cloud-node expects.
        // see:
        // https://github.com/GoogleCloudPlatform/google-cloud-node/pull/1775#issuecomment-259141029
        // https://github.com/GoogleCloudPlatform/google-cloud-node/blob/116436fa789d8b0f7fc5100b19b424e3ec63e6bf/packages/common/src/grpc-service.js#L355
        stream.on('metadata', metadata => {
            // Create a response object with succeeds.
            // TODO: unify this logic with the decoration of gRPC response when it's
            // added. see: https://github.com/googleapis/gax-nodejs/issues/65
            stream.emit('response', {
                code: 200,
                details: '',
                message: 'OK',
                metadata,
            });
        });
    }
    /**
     * Specifies the target stream.
     * @param {ApiCall} apiCall - the API function to be called.
     * @param {Object} argument - the argument to be passed to the apiCall.
     */
    setStream(apiCall, argument) {
        if (this.type === StreamType.SERVER_STREAMING) {
            const retryStream = retryRequest(null, {
                objectMode: true,
                request: () => {
                    if (this._isCancelCalled) {
                        if (this.stream) {
                            this.stream.cancel();
                        }
                        return;
                    }
                    const stream = apiCall(argument, this._callback);
                    this.stream = stream;
                    this.forwardEvents(stream);
                    return stream;
                },
            });
            this.setReadable(retryStream);
            return;
        }
        const stream = apiCall(argument, this._callback);
        this.stream = stream;
        this.forwardEvents(stream);
        if (this.type === StreamType.CLIENT_STREAMING) {
            this.setWritable(stream);
        }
        if (this.type === StreamType.BIDI_STREAMING) {
            this.setReadable(stream);
            this.setWritable(stream);
        }
        if (this._isCancelCalled && this.stream) {
            this.stream.cancel();
        }
    }
}
exports.StreamProxy = StreamProxy;
class GrpcStreamable {
    /**
     * An API caller for methods of gRPC streaming.
     * @private
     * @constructor
     * @param {StreamDescriptor} descriptor - the descriptor of the method structure.
     */
    constructor(descriptor) {
        this.descriptor = descriptor;
    }
    init(settings, callback) {
        return new StreamProxy(this.descriptor.type, callback);
    }
    wrap(func) {
        switch (this.descriptor.type) {
            case StreamType.SERVER_STREAMING:
                return (argument, metadata, options) => {
                    return func(argument, metadata, options);
                };
            case StreamType.CLIENT_STREAMING:
                return (argument, metadata, options, callback) => {
                    return func(metadata, options, callback);
                };
            case StreamType.BIDI_STREAMING:
                return (argument, metadata, options) => {
                    return func(metadata, options);
                };
            default:
                warnings_1.warn('streaming_wrap_unknown_stream_type', `Unknown stream type: ${this.descriptor.type}`);
        }
        return func;
    }
    call(apiCall, argument, settings, stream) {
        stream.setStream(apiCall, argument);
    }
    fail(stream, err) {
        stream.emit('error', err);
    }
    result(stream) {
        return stream;
    }
}
exports.GrpcStreamable = GrpcStreamable;
class StreamDescriptor {
    /**
     * Describes the structure of gRPC streaming call.
     * @constructor
     * @param {StreamType} streamType - the type of streaming.
     */
    constructor(streamType) {
        this.type = streamType;
    }
    apiCaller(settings) {
        // Right now retrying does not work with gRPC-streaming, because retryable
        // assumes an API call returns an event emitter while gRPC-streaming methods
        // return Stream.
        // TODO: support retrying.
        settings.retry = null;
        return new GrpcStreamable(this);
    }
}
exports.StreamDescriptor = StreamDescriptor;
//# sourceMappingURL=streaming.js.map