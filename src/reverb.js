/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Late reverberation filter for Ambisonic content.
 * @author Andrew Allen <bitllama@google.com>
 */

'use strict';

// Internal dependencies.
var Globals = require('./globals.js');
var Utils = require('./utils.js');

/**
 * @class Reverb
 * @description Late reverberation filter for Ambisonic content.
 * @param {AudioContext} context
 * Associated {@link
https://developer.mozilla.org/en-US/docs/Web/API/AudioContext AudioContext}.
 * @param {Object} options
 * @param {Array} options.RT60DurationSecs
 * Multiband RT60 durations (in secs) for each
 * {@link Globals.ReverbBands frequency band}.
 * @param {Number} options.preDelayMs Pre-delay (in ms).
 * @param {Number} options.gain Output gain (linear).
 */
function Reverb (context, options) {
  // Public variables.
  /**
   * Input to .connect() input AudioNodes to.
   * @member {AudioNode} input
   * @memberof Reverb
   */
  /**
   * Outuput to .connect() object from.
   * @member {AudioNode} output
   * @memberof Reverb
   */

  this._context = context;

  // Use defaults for undefined arguments
  if (options == undefined) {
    options = {};
  }
  if (options.RT60DurationSecs == undefined) {
    options.RT60DurationSecs = new Float32Array(Globals.NumReverbBands);
  }
  if (options.preDelayMs == undefined) {
    options.preDelayMs = Globals.DefaultReverbPreDelayMs;
  }
  if (options.gain == undefined) {
    options.gain = Globals.DefaultReverbGain;
  }

  // Used for updating RT60s during runtime.
  this._enabled = false;

  // Compute pre-delay.
  var delayInSecs = options.preDelayMs / 1000;

  // Create nodes.
  this.input = context.createGain();
  this._predelay = context.createDelay(delayInSecs);
  this._convolver = context.createConvolver();
  this.output = context.createGain();

  // Set reverb attenuation.
  this.output.gain.value = options.gain;

  // Disable normalization.
  this._convolver.normalize = false;

  // Connect nodes.
  this.input.connect(this._predelay);
  this._predelay.connect(this._convolver);
  this._convolver.connect(this.output);

  // Compute IR using RT60 values.
  this.setRT60s(options.RT60DurationSecs);
}

/**
 * Re-compute a new impulse response by providing Multiband RT60 durations.
 * @param {Array} RT60DurationSecs
 * Multiband RT60 durations (in secs) for each
 * {@link Globals.ReverbBands frequency band}.
 */
Reverb.prototype.setRT60s = function (RT60DurationSecs) {
  if (RT60DurationSecs.length !== Globals.NumReverbBands) {
    Utils.log("Warning: invalid number of RT60 values provided to reverb.");
    return;
  }

  // Compute impulse response.
  var RT60Samples = new Float32Array(Globals.NumReverbBands);
  var sampleRate = this._context.sampleRate;

  for (var i = 0; i < Math.min(RT60DurationSecs.length, RT60Samples.length); i++) {
    // Clamp within suitable range.
    RT60DurationSecs[i] = Math.max(0, Math.min(
      Globals.DefaultReverbMaxDurationSecs, RT60DurationSecs[i]));

      // Convert seconds to samples.
    RT60Samples[i] =
      Math.round(RT60DurationSecs[i] * sampleRate * Globals.ReverbDurationMultiplier);
  };

  // Determine max RT60 length in samples.
  var RT60MaxLengthSamples = 0;
  for (var i = 0; i < RT60Samples.length; i++) {
    if (RT60Samples[i] > RT60MaxLengthSamples) {
      RT60MaxLengthSamples = RT60Samples[i];
    }
  }

  // Skip this step if there is no reverberation to compute.
  if (RT60MaxLengthSamples < 1) {
    RT60MaxLengthSamples = 1;
  }

  var buffer = this._context.createBuffer(1, RT60MaxLengthSamples, sampleRate);
  var bufferData = buffer.getChannelData(0);

  // Create noise signal (computed once, referenced in each band's routine).
  var noiseSignal = new Float32Array(RT60MaxLengthSamples);
  for (var i = 0; i < RT60MaxLengthSamples; i++) {
    noiseSignal[i] = Math.random() * 2 - 1;
  }

  // Compute the decay rate per-band and filter the decaying noise signal.
  for (var i = 0; i < Globals.NumReverbBands; i++) {
  //for (var i = 0; i < 1; i++) {
    // Compute decay rate.
    var decayRate = -Globals.Log1000 / RT60Samples[i];

    // Construct a standard bandpass filter:
    // H(z) = (b0 * z^0 + b1 * z^-1 + b2 * z^-2) / (1 + a1 * z^-1 + a2 * z^-2)
    var omega = Globals.TwoPi * Globals.ReverbBands[i] / sampleRate;
    var sinOmega = Math.sin(omega);
    var alpha = sinOmega * Math.sinh(Globals.Log2Div2 *
      Globals.ReverbBandwidth * omega / sinOmega);
    var a0CoeffReciprocal = 1 / (1 + alpha);
    var b0Coeff = alpha * a0CoeffReciprocal;
    var a1Coeff = -2 * Math.cos(omega) * a0CoeffReciprocal;
    var a2Coeff = (1 - alpha) * a0CoeffReciprocal;

    // We optimize since b2 = -b0, b1 = 0.
    // Update equation for two-pole bandpass filter:
    //   u[n] = x[n] - a1 * x[n-1] - a2 * x[n-2]
    //   y[n] = b0 * (u[n] - u[n-2])
    var um1 = 0;
    var um2 = 0;
    for (var j = 0; j < RT60Samples[i]; j++) {
      // Exponentially-decaying white noise.
      var x = noiseSignal[j] * Math.exp(decayRate * j);

      // Filter signal with bandpass filter and add to output.
      var u = x - a1Coeff * um1 - a2Coeff * um2;
      bufferData[j] += b0Coeff * (u - um2);

      // Update coefficients.
      um2 = um1;
      um1 = u;
    }
  }

  // Create and apply half-Hann window.
  var halfHannLength =
    Math.round(Globals.DefaultReverbTailOnsetMs / 1000 * sampleRate);
  for (var i = 0; i < Math.min(bufferData.length, halfHannLength); i++) {
    var halfHann =
      0.5 * (1 - Math.cos(Globals.TwoPi * i / (2 * halfHannLength - 1)));
    bufferData[i] *= halfHann;
  }
  this._convolver.buffer = buffer;
}

module.exports = Reverb;