/**

  category all tasks here, each task will have file input and file output
  
*/

var gulp = require('gulp');
var change = require('gulp-change');
var changed = require('gulp-changed');
var minifyJS = require('jsmin2');
var minifyCSS = require('gulp-minify-css');
var minifyJSON = require('gulp-jsonminify');
var merge = require('merge-stream');
var stream = require('stream');
var gutil = require('gulp-util');
var JSZip = require('jszip');
var fs = require('fs-extra');
var path = require('path');
var zipFolder = require('zip-folder');

function cp(data, callback) {
  var paths = data.split(' ');
  var dirname = path.basename(paths[0]);
  fs.copySync(paths[0], paths[1] + '/' + dirname);
  callback();
}

function zip(data, callback) {
  var paths = data.split(' ');
  console.log(data);
  fs.mkdirpSync(paths[1]);
  zipFolder(paths[0], paths[1] + '/application.zip', function(err) {
    if (!err) {
      callback();
    }
  });
}

process.on('message', function(m) {
  switch(m.type) {
    case 'cp':
      cp(m);
      break;
    case 'zip':
      zip(m);
      break;
  }
});

function taskDone(id, output) {
  var result = {
    id: id,
    output: output
  };
  process.send(JSON.stringify(result));
}

function execute(data, callback) {
  if (data.cmd === null) {
    callback();
    return;
  }
  var cmd = data.cmd;
  switch (cmd.type) {
    case 'cp':
      cp(cmd.content, callback);
      break;
    case 'zip':
      zip(cmd.content, callback);
      break;
    default:
      callback();
      break;

  }
}

exports.execute = execute;
