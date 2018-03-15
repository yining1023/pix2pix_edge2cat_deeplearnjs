var editor_background = new Image()
editor_background.src = "editor.png"

var DEBUG = false
var SIZE = 256

var editors = []
var request_in_progress = false

function main() {
  var create_editor = function(config) {
    var editor = new Editor(config)
    var elem = document.getElementById(config.name)
    elem.appendChild(editor.view.ctx.canvas)
    editors.push(editor)
  }

  create_editor({
    name: "edges2pikachu",
    weights_url: "/pix2pix_edge2pikachu_deeplearnjs_old/models/edges2pikachu_AtoB.pict",
    mode: "line",
    clear: "#FFFFFF",
    colors: {
      line: "#000000",
      eraser: "#ffffff",
    },
    draw: "#000000",
    initial_input: "/pix2pix_edge2pikachu_deeplearnjs_old/edges2pikachu-input.png",
    initial_output: "/pix2pix_edge2pikachu_deeplearnjs_old/edges2pikachu-output.png",
    sheet_url: "/pix2pix_edge2pikachu_deeplearnjs_old/edges2pikachu-sheet.png",
  })

  window.requestAnimationFrame(frame)
}
window.onload = main

function render() {
  for (var i = 0; i < editors.length; i++) {
    editors[i].render()
  }
}


// model

var weights_cache = {}
function fetch_weights(path, progress_cb) {
  return new Promise(function(resolve, reject) {
    if (path in weights_cache) {
      resolve(weights_cache[path])
      return
    }

    var xhr = new XMLHttpRequest()
    xhr.open("GET", path, true)
    xhr.responseType = "arraybuffer"

    xhr.onprogress = function(e) {
      progress_cb(e.loaded, e.total)
    }

    xhr.onload = function(e) {
      if (xhr.status != 200) {
        reject("missing model")
        return
      }
      var buf = xhr.response
      if (!buf) {
        reject("invalid arraybuffer")
        return
      }

      var parts = []
      var offset = 0
      while (offset < buf.byteLength) {
        var b = new Uint8Array(buf.slice(offset, offset+4))
        offset += 4
        var len = (b[0] << 24) + (b[1] << 16) + (b[2] << 8) + b[3]
        parts.push(buf.slice(offset, offset + len))
        offset += len
      }

      var shapes = JSON.parse((new TextDecoder("utf8")).decode(parts[0]))
      var index = new Float32Array(parts[1])
      var encoded = new Uint8Array(parts[2])

      // decode using index
      var arr = new Float32Array(encoded.length)
      for (var i = 0; i < arr.length; i++) {
        arr[i] = index[encoded[i]]
      }

      var weights = {}
      var offset = 0
      for (var i = 0; i < shapes.length; i++) {
        var shape = shapes[i].shape
        var size = shape.reduce((total, num) => total * num)
        var values = arr.slice(offset, offset+size)
        var dlarr = dl.Array1D.new(values, "float32")
        weights[shapes[i].name] = dlarr.reshape(shape)
        offset += size
      }
      weights_cache[path] = weights
      resolve(weights)
    }
    xhr.send(null)
  })
}

function model(input, weights) {
  const math = dl.ENV.math

  function preprocess(input) {
    return math.subtract(math.multiply(input, dl.Scalar.new(2)), dl.Scalar.new(1))
  }

  function deprocess(input) {
    return math.divide(math.add(input, dl.Scalar.new(1)), dl.Scalar.new(2))
  }

  function batchnorm(input, scale, offset) {
    var moments = math.moments(input, [0, 1])
    const varianceEpsilon = 1e-5
    return math.batchNormalization3D(input, moments.mean, moments.variance, varianceEpsilon, scale, offset)
  }

  function conv2d(input, filter, bias) {
    return math.conv2d(input, filter, bias, [2, 2], "same")
  }

  function deconv2d(input, filter, bias) {
    var convolved = math.conv2dTranspose(input, filter, [input.shape[0]*2, input.shape[1]*2, filter.shape[2]], [2, 2], "same")
    var biased = math.add(convolved, bias)
    return biased
  }

  var preprocessed_input = preprocess(input)

  var layers = []

  var filter = weights["generator/encoder_1/conv2d/kernel"]
  var bias = weights["generator/encoder_1/conv2d/bias"]
  var convolved = conv2d(preprocessed_input, filter, bias)
  layers.push(convolved)

  for (var i = 2; i <= 8; i++) {
    var scope = "generator/encoder_" + i.toString()
    var filter = weights[scope + "/conv2d/kernel"]
    var bias = weights[scope + "/conv2d/bias"]
    var layer_input = layers[layers.length - 1]
    var rectified = math.leakyRelu(layer_input, 0.2)
    var convolved = conv2d(rectified, filter, bias)
    var scale = weights[scope + "/batch_normalization/gamma"]
    var offset = weights[scope + "/batch_normalization/beta"]
    var normalized = batchnorm(convolved, scale, offset)
    layers.push(normalized)
  }

  for (var i = 8; i >= 2; i--) {
    if (i == 8) {
      var layer_input = layers[layers.length - 1]
    } else {
      var skip_layer = i - 1
      var layer_input = math.concat3D(layers[layers.length - 1], layers[skip_layer], 2)
    }
    var rectified = math.relu(layer_input)
    var scope = "generator/decoder_" + i.toString()
    var filter = weights[scope + "/conv2d_transpose/kernel"]
    var bias = weights[scope + "/conv2d_transpose/bias"]
    var convolved = deconv2d(rectified, filter, bias)
    var scale = weights[scope + "/batch_normalization/gamma"]
    var offset = weights[scope + "/batch_normalization/beta"]
    var normalized = batchnorm(convolved, scale, offset)
    // missing dropout
    layers.push(normalized)
  }

  var layer_input = math.concat3D(layers[layers.length - 1], layers[0], 2)
  var rectified = math.relu(layer_input)
  var filter = weights["generator/decoder_1/conv2d_transpose/kernel"]
  var bias = weights["generator/decoder_1/conv2d_transpose/bias"]
  var convolved = deconv2d(rectified, filter, bias)
  var rectified = math.tanh(convolved)
  layers.push(rectified)

  var output = layers[layers.length - 1]
  var deprocessed_output = deprocess(output)

  return deprocessed_output
}


// editor

function Editor(config) {
  this.config = config
  this.view = new View(this.config.name, 800, 400)

  this.buffers = []

  this.buffer = createContext(SIZE, SIZE, SCALE)
  this.buffer.fillStyle = this.config.clear
  this.buffer.fillRect(0, 0, SIZE, SIZE)

  var image = new Image()
  image.src = this.config.initial_input
  image.onload = () => {
    this.buffer.drawImage(image, 0, 0)
  }

  this.output = createContext(SIZE, SIZE, 1)
  var output = new Image()
  output.src = this.config.initial_output
  output.onload = () => {
    this.output.drawImage(output, 0, 0)
  }

  this.progress = null
  this.last_failure = null

  this.sheet_loaded = false
  this.sheet = new Image()
  this.sheet.src = this.config.sheet_url
  this.sheet.onload = () => {
    this.sheet_loaded = true
    update()
  }
  this.sheet_index = 0
}

Editor.prototype = {
  push_buffer: function() {
    this.buffers.push(this.buffer)
    var buffer = createContext(SIZE, SIZE, SCALE)
    buffer.save()
    buffer.scale(1/SCALE, 1/SCALE)
    buffer.drawImage(this.buffer.canvas, 0, 0)
    buffer.restore()
    this.buffer = buffer
  },
  pop_buffer: function() {
    if (this.buffers.length == 0) {
      return
    }
    this.buffer = this.buffers.pop()
  },
  render: function() {
    var v = this.view

    v.ctx.clearRect(0, 0, v.f.width, v.f.height)
    v.ctx.save()
    v.ctx.scale(1/SCALE, 1/SCALE)
    v.ctx.drawImage(editor_background, 0, 0)
    v.ctx.restore()

    v.frame("tools", 8, 41, 100, 250, () => {
      var i = 0
      for (var name in this.config.colors) {
        var color = this.config.colors[name]
        v.frame("color_selector", 0, i*21, v.f.width, 20, () => {
          if (v.contains(mouse_pos)) {
            cursor_style = "pointer"
          }

          if (mouse_released && v.contains(mouse_pos)) {
            this.config.draw = color
            update()
          }

          if (this.config.draw == color) {
            v.ctx.save()
            var radius = 5
            v.ctx.beginPath()
            v.ctx.moveTo(radius, 0)
            var sides = [v.f.width, v.f.height, v.f.width, v.f.height]
            for (var i = 0; i < sides.length; i++) {
              var side = sides[i]
              v.ctx.lineTo(side - radius, 0)
              v.ctx.arcTo(side, 0, side, radius, radius)
              v.ctx.translate(side, 0)
              v.ctx.rotate(90 / 180 * Math.PI)
            }
            v.ctx.fillStyle = rgba([0.5, 0.5, 0.5, 1.0])
            v.ctx.stroke()
            v.ctx.restore()
            v.ctx.font = "bold 8pt Arial"
          } else {
            v.ctx.font = "8pt Arial"
          }

          v.ctx.fillText(name, v.f.width - v.ctx.measureText(name).width - 26, 10)

          v.frame("color", v.f.width-25, 0, 20, 20, () => {
            v.ctx.beginPath()
            v.ctx.fillStyle = "#666666"
            v.ctx.arc(10, 10, 9, 0, 2 * Math.PI, false)
            v.ctx.fill()
            v.ctx.beginPath()
            v.ctx.fillStyle = color
            v.ctx.arc(10, 10, 8, 0, 2 * Math.PI, false)
            v.ctx.fill()
          })
        })
        i++
      }
    })

    v.frame("output", 530, 40, 256, 256, () => {
      v.ctx.drawImage(this.output.canvas, 0, 0)
    })

    v.frame("input", 140, 40, 256, 256+40, () => {
      v.frame("image", 0, 0, 256, 256, () => {
        v.ctx.drawImage(this.buffer.canvas, 0, 0, v.f.width, v.f.height)

        if (v.contains(mouse_pos)) {
          cursor_style = "crosshair"
          if (this.config.mode == "line" && this.config.draw == "#ffffff") {
            // eraser tool
            cursor_style = "url(/eraser.png) 8 8, auto"
          }
        }

        if (this.config.mode == "line") {
          // this is to make undo work with lines, rather than removing only single frame line segments
          var drag_from_outside = mouse_down && v.contains(mouse_pos) && !v.contains(last_mouse_pos)
          var start_inside = mouse_pressed && v.contains(mouse_pos)
          if (drag_from_outside || start_inside) {
            this.push_buffer()
          }

          if (mouse_down && v.contains(mouse_pos)) {
            var last = v.relative(last_mouse_pos)
            var cur = v.relative(mouse_pos)
            this.buffer.beginPath()
            this.buffer.lineCap = "round"
            this.buffer.strokeStyle = this.config.draw
            if (this.config.draw == "#ffffff") {
              // eraser mode
              this.buffer.lineWidth = 15
            } else {
              this.buffer.lineWidth = 1
            }
            this.buffer.moveTo(last.x, last.y)
            this.buffer.lineTo(cur.x, cur.y)
            this.buffer.stroke()
            this.buffer.closePath()
          }
        } else {
          if (v.contains(drag_start)) {
            var start = v.relative(drag_start)
            var end = v.relative(mouse_pos)
            var width = end.x - start.x
            var height = end.y - start.y
            if (mouse_down) {
              v.ctx.save()
              v.ctx.rect(0, 0, v.f.width, v.f.height)
              v.ctx.clip()
              v.ctx.fillStyle = this.config.draw
              v.ctx.fillRect(start.x, start.y, width, height)
              v.ctx.restore()
            } else if (mouse_released) {
              this.push_buffer()
              this.buffer.fillStyle = this.config.draw
              this.buffer.fillRect(start.x, start.y, width, height)
              v.ctx.drawImage(this.buffer.canvas, 0, 0, v.f.width, v.f.height)
            }
          }
        }
      })
    })

    v.frame("process_button", 461 - 32, 148, 32*2, 40, () => {
      if (this.progress != null) {
        v.ctx.font = "12px Arial"
        v.ctx.fillStyle = "#000"
        var s = "downloading"
        v.ctx.fillText(s, (v.f.width - v.ctx.measureText(s).width)/2, 5)
        s = "model"
        v.ctx.fillText(s, (v.f.width - v.ctx.measureText(s).width)/2, 15)

        v.frame("progress_bar", 0, 25, v.f.width, 15, () => {
          v.ctx.fillStyle = "#f92672"
          v.ctx.fillRect(0, 0, v.f.width * this.progress, v.f.height)
        })
      } else if (request_in_progress) {
        do_button(v, "running")
      } else {
        if (do_button(v, "process")) {
          if (request_in_progress) {
            console.log("request already in progress")
            return
          }
          request_in_progress = true
          this.last_failure = null

          this.progress = 0
          progress_cb = (retrieved, total) => {
            this.progress = retrieved/total
            update()
          }

          fetch_weights(this.config.weights_url, progress_cb).then((weights) => {
            this.progress = null
            update()
            // delay a short period of time so that UI updates before the model uses all the CPU
            delay(() => {
              // var g = new dl.Graph()

              var convert = createContext(SIZE, SIZE, 1)
              convert.drawImage(this.buffer.canvas, 0, 0, convert.canvas.width, convert.canvas.height)
              var input_uint8_data = convert.getImageData(0, 0, SIZE, SIZE).data
              var input_float32_data = Float32Array.from(input_uint8_data, (x) => x / 255)

              console.time('render')
              const math = dl.ENV.math
              math.startScope()
              var input_rgba = dl.Array3D.new([SIZE, SIZE, 4], input_float32_data, "float32")
              var input_rgb = math.slice3D(input_rgba, [0, 0, 0], [SIZE, SIZE, 3])

              var output_rgb = model(input_rgb, weights)

              var alpha = dl.Array3D.ones([SIZE, SIZE, 1])
              var output_rgba = math.concat3D(output_rgb, alpha, 2)

              output_rgba.getValuesAsync().then((output_float32_data) => {
                var output_uint8_data = Uint8ClampedArray.from(output_float32_data, (x) => x * 255)
                this.output.putImageData(new ImageData(output_uint8_data, SIZE, SIZE), 0, 0)
                math.endScope()
                console.timeEnd('render')
                request_in_progress = false
                update()
              })
            })
          }, (e) => {
            this.last_failure = e
            this.progress = null
            request_in_progress = false
            update()
          })
        }
      }
    })

    v.frame("undo_button", 192-32, 310, 64, 40, () => {
      if (do_button(v, "undo")) {
        this.pop_buffer()
        update()
      }
    })

    v.frame("clear_button", 270-32, 310, 64, 40, () => {
      if (do_button(v, "clear")) {
        this.buffers = []
        this.buffer.fillStyle = this.config.clear
        this.buffer.fillRect(0, 0, SIZE, SIZE)
        this.output.fillStyle = "#FFFFFF"
        this.output.fillRect(0, 0, SIZE, SIZE)
      }
    })

    if (this.sheet_loaded) {
      v.frame("random_button", 347-32, 310, 64, 40, () => {
        if (do_button(v, "random")) {
          // pick next sheet entry
          this.buffers = []
          var y_offset = this.sheet_index * SIZE
          this.buffer.drawImage(this.sheet, 0, y_offset, SIZE, SIZE, 0, 0, SIZE, SIZE)
          this.output.drawImage(this.sheet, SIZE, y_offset, SIZE, SIZE, 0, 0, SIZE, SIZE)
          this.sheet_index = (this.sheet_index + 1) % (this.sheet.height / SIZE)
          update()
        }
      })
    }

    v.frame("save_button", 655-32, 310, 64, 40, () => {
      if (do_button(v, "save")) {
        // create a canvas to hold the part of the canvas that we wish to store
        var x = 125 * SCALE
        var y = 0
        var width = 800 * SCALE - x
        var height = 310 * SCALE - y
        var convert = createContext(width, height, 1)
        convert.drawImage(v.ctx.canvas, x, y, width, height, 0, 0, convert.canvas.width, convert.canvas.height)
        var data_b64 = convert.canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "")
        var data = b64_to_bin(data_b64)
        var blob = new Blob([data], {type: "application/octet-stream"})
        var url = window.URL.createObjectURL(blob)
        var a = document.createElement("a")
        a.href = url
        a.download = "pix2pix.png"
        // use createEvent instead of .click() to work in firefox
        // also can"t revoke the object url because firefox breaks
        var event = document.createEvent("MouseEvents")
        event.initEvent("click", true, true)
        a.dispatchEvent(event)
        // safari doesn"t work at all
      }
    })

    if (this.last_failure != null) {
      v.frame("server_error", 50, 350, v.f.width, 50, () => {
        v.ctx.font = "20px Arial"
        v.ctx.fillStyle = "red"
        v.center_text(fmt("error %s", this.last_failure))
      })
    }
  },
}

// utility

function createContext(width, height, scale) {
  var canvas = document.createElement("canvas")
  canvas.width = width * scale
  canvas.height = height * scale
  stylize(canvas, {
    width: fmt("%dpx", width),
    height: fmt("%dpx", height),
    margin: "10px auto 10px auto",
  })
  var ctx = canvas.getContext("2d")
  ctx.scale(scale, scale)
  return ctx
}

function b64_to_bin(str) {
  var binstr = atob(str)
  var bin = new Uint8Array(binstr.length)
  for (var i = 0; i < binstr.length; i++) {
    bin[i] = binstr.charCodeAt(i)
  }
  return bin
}

function delay(fn) {
  setTimeout(fn, 0)
}

function default_format(obj) {
  if (typeof(obj) === "string") {
    return obj
  } else {
    return JSON.stringify(obj)
  }
}

function fmt() {
  if (arguments.length === 0) {
    return "error"
  }

  var format = arguments[0]
  var output = ""

  var arg_index = 1
  var i = 0

  while (i < format.length) {
    var c = format[i]
    i++

    if (c != "%") {
      output += c
      continue
    }

    if (i === format.length) {
      output += "%!(NOVERB)"
      break
    }

    var flag = format[i]
    i++

    var pad_char = " "

    if (flag == "0") {
      pad_char = "0"
    } else {
      // not a flag
      i--
    }

    var width = 0
    while (format[i] >= "0" && format[i] <= "9") {
      width *= 10
      width += parseInt(format[i], 10)
      i++
    }

    var f = format[i]
    i++

    if (f === "%") {
      output += "%"
      continue
    }

    if (arg_index === arguments.length) {
      output += "%!" + f + "(MISSING)"
      continue
    }

    var arg = arguments[arg_index]
    arg_index++

    var o = null

    if (f === "v") {
      o = default_format(arg)
    } else if (f === "s" && typeof(arg) === "string") {
      o = arg
    } else if (f === "T") {
      o = typeof(arg)
    } else if (f === "d" && typeof(arg) === "number") {
      o = arg.toFixed(0)
    } else if (f === "f" && typeof(arg) === "number") {
      o = arg.toString()
    } else if (f === "x" && typeof(arg) === "number") {
      o = Math.round(arg).toString(16)
    } else if (f === "t" && typeof(arg) === "boolean") {
      if (arg) {
        o = "true"
      } else {
        o = "false"
      }
    } else {
      output += "%!" + f + "(" + typeof(arg) + "=" + default_format(arg) + ")"
    }

    if (o !== null) {
      if (o.length < width) {
        output += Array(width - o.length + 1).join(pad_char)
      }
      output += o
    }
  }

  if (arg_index < arguments.length) {
    output += "%!(EXTRA "
    while (arg_index < arguments.length) {
      var arg = arguments[arg_index]
      output += typeof(arg) + "=" + default_format(arg)
      if (arg_index < arguments.length - 1) {
        output += ", "
      }
      arg_index++
    }
    output += ")"
  }

  return output
}


// immediate mode UI

var SCALE = 2

var updated = true
var frame_rate = 0
var now = new Date()
var last_frame = new Date()
var animations = {}
var values = {}

var cursor_style = null
var mouse_pos = [0, 0]
var last_mouse_pos = [0, 0]
var drag_start = [0, 0]
var mouse_down = false
var mouse_pressed = false
var mouse_released = false

if (DEBUG) {
  var fps_elem = document.createElement("div")
  stylize(fps_elem, {
    width: "300px",
    height: "20px",
    margin: "5px",
    fontFamily: "Monaco",
    fontSize: "12px",
    position: "absolute",
    top: fmt("%dpx", 10),
    right: fmt("%dpx", 10),
  })
  document.body.insertBefore(fps_elem, document.body.firstChild)

  var status_elem = document.createElement("div")
  stylize(status_elem, {
    width: "10px",
    height: "10px",
    margin: "5px",
    position: "absolute",
    top: fmt("%dpx", 10),
    left: fmt("%dpx", 10),
  })
  document.body.insertBefore(status_elem, document.body.firstChild)
}

function View(name, width, height) {
  this.ctx = createContext(width, height, SCALE)
	// https://developer.apple.com/library/safari/documentation/AudioVideo/Conceptual/HTML-canvas-guide/AddingText/AddingText.html
  this.ctx.textBaseline = "middle"
  this.frames = [{name: name, offset_x: 0, offset_y: 0, width: width, height: height}]
  this.f = this.frames[0]
}

View.prototype = {
  push_frame: function(name, x, y, width, height) {
    this.ctx.save()
    this.ctx.translate(x, y)
  	var current = this.frames[this.frames.length - 1]
  	var next = {name: name, offset_x: current.offset_x + x, offset_y: current.offset_y + y, width: width, height: height}
  	this.frames.push(next)
    this.f = next
  },
  pop_frame: function() {
    this.ctx.restore()
    this.frames.pop()
    this.f = this.frames[this.frames.length - 1]
  },
  frame: function(name, x, y, width, height, func) {
    this.push_frame(name, x, y, width, height)
    func()
    this.pop_frame()
  },
  frame_path: function() {
    var parts = []
    for (var i = 0; i < this.frames.length; i++) {
      parts.push(this.frames[i].name)
    }
    return parts.join(".")
  },
  relative: function(pos) {
    // adjust x and y relative to the top left corner of the canvas
    // then adjust relative to the current frame
    var rect = this.ctx.canvas.getBoundingClientRect()
    return {x: pos.x - rect.left - this.f.offset_x, y: pos.y - rect.top - this.f.offset_y}
  },
  contains: function(pos) {
    // first check that position is inside canvas container
    var rect = this.ctx.canvas.getBoundingClientRect()
    if (pos.x < rect.left || pos.x > rect.left + rect.width || pos.y < rect.top || pos.y > rect.top + rect.height) {
      return false
    }
    // translate coordinates to the current frame
    var rel = this.relative(pos)
    return 0 < rel.x && rel.x < this.f.width && 0 < rel.y && rel.y < this.f.height
  },
  put_image_data: function(d, x, y) {
    this.ctx.putImageData(d, (x + this.f.offset_x) * SCALE, (y + this.f.offset_y) * SCALE)
  },
  center_text: function(s) {
    this.ctx.fillText(s, (this.f.width - this.ctx.measureText(s).width)/2, this.f.height/2)
  },
}

function do_button(v, text) {
  name = v.frame_path()

  if (v.contains(mouse_pos)) {
    cursor_style = "pointer"
  }

  if (request_in_progress) {
    animate(name, parse_color("#aaaaaaFF"), 100)
  } else if (mouse_down && v.contains(mouse_pos)) {
    animate(name, parse_color("#FF0000FF"), 50)
  } else {
    if (v.contains(mouse_pos)) {
      animate(name, parse_color("#f477a5FF"), 100)
    } else {
      animate(name, parse_color("#f92672FF"), 100)
    }
  }

  v.ctx.save()
  var radius = 5
  v.ctx.beginPath()
  v.ctx.moveTo(radius, 0)
  var sides = [v.f.width, v.f.height, v.f.width, v.f.height]
  for (var i = 0; i < sides.length; i++) {
    var side = sides[i]
    v.ctx.lineTo(side - radius, 0)
    v.ctx.arcTo(side, 0, side, radius, radius)
    v.ctx.translate(side, 0)
    v.ctx.rotate(90 / 180 * Math.PI)
  }
  v.ctx.fillStyle = rgba(calculate(name))
  v.ctx.fill()
  v.ctx.restore()

  v.ctx.font = "16px Arial"
  v.ctx.fillStyle = "#f8f8f8"
  v.center_text(text)

  if (request_in_progress) {
    return false
  }

  return mouse_released && v.contains(mouse_pos) && v.contains(drag_start)
}

function stylize(elem, style) {
  for (var key in style) {
    elem.style[key] = style[key]
  }
}

function update() {
  updated = true
}

function frame() {
  var raf = window.requestAnimationFrame(frame)

  if (!updated && Object.keys(animations).length == 0) {
    if (DEBUG) {
      status_elem.style.backgroundColor = "black"
    }
    return
  }
  if (DEBUG) {
    status_elem.style.backgroundColor = "red"
  }

  now = new Date()
  cursor_style = null
  updated = false

  try {
    render()
  } catch (e) {
    window.cancelAnimationFrame(raf)
    throw e
  }

  if (cursor_style == null) {
    document.body.style.cursor = "default"
  } else {
    document.body.style.cursor = cursor_style
  }

  if (DEBUG) {
    var decay = 0.9
    var current_frame_rate = 1 / ((now - last_frame) / 1000)
    frame_rate = frame_rate * decay + current_frame_rate * (1 - decay)
    fps_elem.textContent = fmt("fps: %d", frame_rate)
  }

  last_frame = now
  last_mouse_pos = mouse_pos
  mouse_pressed = false
  mouse_released = false
}

function array_equal(a, b) {
  if (a.length != b.length) {
    return false
  }

  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false
    }
  }
  return true
}

function animate(name, end, duration) {
  if (values[name] == undefined) {
    // no value has been set for this element, set it immediately
    values[name] = end
    return
  }

  var v = calculate(name)
  if (array_equal(v, end)) {
    return
  }
  if (duration == 0) {
    delete animations[name]
    values[name] = end
    return
  }
  var a = animations[name]
  if (a != undefined && array_equal(a.end, end)) {
    return
  }
  animations[name] = {time: now, start: v, end: end, duration: duration}
}

function calculate(name) {
  if (values[name] == undefined) {
    throw "calculate used before calling animate"
  }

  var a = animations[name]
  if (a != undefined) {
    // update value
    var t = Math.min((now - a.time)/a.duration, 1.0)
    t = t*t*t*(t*(t*6 - 15) + 10) // smootherstep
    var result = []
    for (var i = 0; i < a.start.length; i++) {
      result[i] = a.start[i] + (a.end[i] - a.start[i]) * t
    }
    if (t == 1.0) {
      delete animations[name]
    }
    values[name] = result
  }
  return values[name]
}

function rgba(v) {
  return fmt("rgba(%d, %d, %d, %f)", v[0] * 255, v[1] * 255, v[2] * 255, v[3])
}

var parse_color = function(c) {
	return [
		parseInt(c.substr(1,2), 16) / 255,
		parseInt(c.substr(3,2), 16) / 255,
		parseInt(c.substr(5,2), 16) / 255,
    parseInt(c.substr(7,2), 16) / 255,
	]
}

document.addEventListener("mousemove", function(e) {
  mouse_pos = {x: e.clientX, y: e.clientY}
  update()
})

document.addEventListener("mousedown", function(e) {
  drag_start = {x: e.clientX, y: e.clientY}
  mouse_down = true
  mouse_pressed = true
  update()
})

document.addEventListener("mouseup", function(e) {
  mouse_down = false
  mouse_released = true
  update()
});