'use strict';

/**
 * Module dependencies.
 */
var express = require('express'),
  app = express(),
  http = require('http').createServer(app),
  path = require('path'),
  db = require('./db'),
  _ = require('lodash'),
  mongoose = require('mongoose'),
  expressValidator = require('express-validator'),
  bodyParser = require('body-parser'),
  rimraf = require("rimraf"),
  mkdirp = require("mkdirp"),
  multiparty = require('multiparty'),

  // paths/constants
  fileInputName = process.env.FILE_INPUT_NAME || "qqfile",
  uploadedFilesPath = 'store/uploads/',
  chunkDirName = "chunks",
  maxFileSize = process.env.MAX_FILE_SIZE || 0, // in bytes, 0 for unlimited
  AWS = require('aws-sdk'),
  fs = require('fs'),
  async = require('async');

AWS.config.update({
  accessKeyId: process.env.AWS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_KEY
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname + '/index.html'));
});


app.use(express.static(__dirname + '/store'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

app.use(expressValidator());

var server = http.listen(process.env.PORT || 3000, function() {
  console.log("Great! App is ready.");
});

var io = require('socket.io')(server);
io.on('connection', function(socket) {
  // whenever any user upload file
  socket.on('fileupload', function() {
    // sending to all clients
    io.emit('upload', 'fileuploaded');
  });
});

var user;
mongoose.connection.on('connected', function() {
  user = require('./user')(app);
});

app.route('/login')
  .post(function(req, res) {
    req.assert('email', 'You must enter a valid email address').isEmail();
    req.assert('password', 'Password must be between 8-20 characters long').len(8, 20);

    var errors = req.validationErrors();
    if (errors) {
      return res.status(400).send(errors);
    }
    user.signin(req.body, function(err, usr) {
      if (err) return res.status(500).send(err);
      // var copied = usr.toObject();
      // delete copied.password;
      res.send({
        user: usr
      })
    })
  });

app.route('/addUser')
  .post(function(req, res) {
    // entiries validations
    req.assert('firstname', 'You must enter a firstname').notEmpty();
    req.assert('lastname', 'You must enter a lastname').notEmpty();
    req.assert('email', 'You must enter a valid email address').isEmail();
    req.assert('password', 'Password must be between 8-20 characters long').len(8, 20);

    var errors = req.validationErrors();
    if (errors) {
      return res.status(400).send(errors);
    }

    user.addUser(req.body, function(err, msg) {
      if (err) return res.status(500).send(err);
      res.send({
        msg: msg
      });
    });
  });

app.route('/getUsers')
  .get(function(req, res) {
    user.getUsers(function(err, users) {
      if (err) return res.status(500).send(err);
      res.send({
        users: users
      })
    })
  })

function writeDBandAWS(_id, path, callback) {
  console.log(_id, path);
  var s3 = new AWS.S3();
  async.auto({
    getFileName: function(next) {
      user.getFileName(_id, function(err, name) {
        if (err) return next(err);
        next(null, name);
      });
    },
    saveAws: ['getFileName', function(next, result) {
      fs.readFile(path, function(err, file_buffer) {
        if (err) return next(err);
        var params = {
          Bucket: 'faceflipper',
          Key: result.getFileName,
          Body: file_buffer,
          Expires: 435435344,
          ACL: 'public-read'
        };

        s3.putObject(params, function(err, data) {
          if (err) next(err);
          next(null, result.getFileName);
        });
      });
    }],
    updateUser: ['saveAws', function(next, result) {
      user.updateUser(_id, result.saveAws, function(err, data) {
        if (err) return next(err);
        next(null, 'done');
      });
    }]
  }, function(err, resss) {
    if (err) return callback(err);
    callback(null, 'done');
  });
}

app.post("/upload", onUpload);

function onUpload(req, res) {
  var form = new multiparty.Form();

  form.parse(req, function(err, fields, files) {
    var partIndex = fields.qqpartindex;
    // text/plain is required to ensure support for IE9 and older
    res.set("Content-Type", "text/plain");

    if (partIndex == null) {
      onSimpleUpload(fields, files[fileInputName][0], res);
    } else {
      onChunkedUpload(fields, files[fileInputName][0], res, req.query._id);
    }
  });
}

function onSimpleUpload(fields, file, res) {
  var uuid = fields.qquuid,
    responseData = {
      success: false
    };

  file.name = fields.qqfilename;

  if (isValid(file.size)) {
    moveUploadedFile(file, uuid, function() {
        responseData.success = true;
        res.send(responseData);
      },
      function() {
        responseData.error = "Problem copying the file!";
        res.send(responseData);
      });
  } else {
    failWithTooBigFile(responseData, res);
  }
}

function onChunkedUpload(fields, file, res, id) {
  var size = parseInt(fields.qqtotalfilesize),
    uuid = fields.qquuid,
    index = fields.qqpartindex,
    totalParts = parseInt(fields.qqtotalparts),
    responseData = {
      success: false
    };

  file.name = fields.qqfilename;

  if (isValid(size)) {
    storeChunk(file, uuid, index, totalParts, function() {
        if (index < totalParts - 1) {
          responseData.success = true;
          res.send(responseData);
          console.log('totalParts')
        } else {
          combineChunks(file, uuid, id, function() {
              responseData.success = true;
              res.send(responseData);
            },
            function() {
              responseData.error = "Problem conbining the chunks!";
              res.send(responseData);
            });
        }
      },
      function(reset) {
        responseData.error = "Problem storing the chunk!";
        res.send(responseData);
      });
  } else {
    failWithTooBigFile(responseData, res);
  }
}

function failWithTooBigFile(responseData, res) {
  responseData.error = "Too big!";
  responseData.preventRetry = true;
  res.send(responseData);
}

function onDeleteFile(req, res) {
  var uuid = req.params.uuid,
    dirToDelete = uploadedFilesPath + uuid;

  rimraf(dirToDelete, function(error) {
    if (error) {
      console.error("Problem deleting file! " + error);
      res.status(500);
    }

    res.send();
  });
}

function isValid(size) {
  return maxFileSize === 0 || size < maxFileSize;
}

function moveFile(destinationDir, sourceFile, destinationFile, success, failure) {
  mkdirp(destinationDir, function(error) {
    var sourceStream, destStream;

    if (error) {
      console.error("Problem creating directory " + destinationDir + ": " + error);
      failure();
    } else {
      sourceStream = fs.createReadStream(sourceFile);
      destStream = fs.createWriteStream(destinationFile);

      sourceStream
        .on("error", function(error) {
          console.error("Problem copying file: " + error.stack);
          destStream.end();
          failure();
        })
        .on("end", function() {
          destStream.end();
          console.log('moveFile', sourceStream.path, destStream.path);
          success();
        })
        .pipe(destStream);
    }
  });
}

function moveUploadedFile(file, uuid, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + "/",
    fileDestination = destinationDir + file.name;

  moveFile(destinationDir, file.path, fileDestination, success, failure);
}

function storeChunk(file, uuid, index, numChunks, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
    chunkFilename = getChunkFilename(index, numChunks),
    fileDestination = destinationDir + chunkFilename;

  moveFile(destinationDir, file.path, fileDestination, success, failure);
}

function combineChunks(file, uuid, id, success, failure) {
  var chunksDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
    destinationDir = uploadedFilesPath + uuid + "/",
    fileDestination = destinationDir + file.name;


  fs.readdir(chunksDir, function(err, fileNames) {
    var destFileStream;

    if (err) {
      console.error("Problem listing chunks! " + err);
      failure();
    } else {
      fileNames.sort();
      destFileStream = fs.createWriteStream(fileDestination, {
        flags: "a"
      });

      appendToStream(destFileStream, chunksDir, fileNames, 0, function() {
          rimraf(chunksDir, function(rimrafError) {
            if (rimrafError) {
              console.log("Problem deleting chunks dir! " + rimrafError);
            }
          });
          writeDBandAWS(id, destFileStream.path, function(err, result) {
            if (err) console.log(err);
            else success();
          });
        },
        failure);
    }
  });
}

function appendToStream(destStream, srcDir, srcFilesnames, index, success, failure) {
  if (index < srcFilesnames.length) {
    fs.createReadStream(srcDir + srcFilesnames[index])
      .on("end", function() {
        appendToStream(destStream, srcDir, srcFilesnames, index + 1, success, failure);
      })
      .on("error", function(error) {
        console.error("Problem appending chunk! " + error);
        destStream.end();
        failure();
      })
      .pipe(destStream, {
        end: false
      });
  } else {
    destStream.end();
    success();
  }
}

function getChunkFilename(index, count) {
  var digits = new String(count).length,
    zeros = new Array(digits + 1).join("0");

  return (zeros + index).slice(-digits);
}
