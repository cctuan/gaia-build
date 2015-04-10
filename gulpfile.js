'use strict';

/* jshint node: true */

var gulp = require('gulp');
var argv = require('yargs').argv;
var rimraf = require('gulp-rimraf');
var workerFarm = require('worker-farm');
var fs = require('fs');
var Make = require('./commandGen');
var through = require('through2');
var path = require('path');
var runSeq = require('gulp-run-sequence');
var merge = require('merge-stream');
var dom  = require('gulp-dom');
var appList = argv.app ? [argv.app] : fs.readdirSync('apps');
var ignores = ['!apps/**/+(build|test)/**'];
var stream = require('stream');
var gutil = require('gulp-util');
var fork = require('child_process').fork;
var test = require('./builder');
var lazypipe = require('lazypipe');
// the edges of each node should be a string or it cannot be successfully built
var dag = require('breeze-dag');

var configResult = {};

var Task = function(target, data) {
  this.parent = [];
  this.data = data;
  this.target = target;
};

var Builder = function(config, endCb) {
  this.workers = [];
  this.endCb = endCb;
  this.config = config;
  this.taskTree = {};
  this.runTasks = [];
  this.edges = [];
  this.start();
};

// if deps is newer than target, then execute it
Builder.prototype = {
  WORKER_NUM: 4, // should detect cpu number
  start: function() {
    this.endCb();
    this.initTaskTree();
    //this.initWorkers();
    this.runTasks.forEach(this.scanEdges, this);
    this.exec();
  },
  initWorkers: function() {
    for (var i = 0; i < this.WORKER_NUM; i++) {
      var forker = fork(__dirname + '/builder.js');
      this.workers.push({
        runner: forker,
        status: false,
        cmd: null
      });
      forker.on('message', this.onMessage.bind(this));
    }
  },

  initTaskTree: function() {
    var initData = this.config['start'];
    var initTask = new Task(null, initData);
    this.scanChildren(initTask);
  },

  scanChildren: function(task) {
    //console.log(task);
    if (task.data.deps && task.data.deps.length == 0) {
      if (this.shouldRunCheck(task)) {
        this.runTasks.push(task);
      }
      return;
    }
    for (var i = 0; i < task.data.deps.length; i++) {
      var dep = task.data.deps[i];
      if (this.config[dep]) {
        var subTask = new Task(dep, this.config[dep]);
        subTask.parent.push(task);
        this.scanChildren(subTask);
      }
    }
  },

  shouldRunCheck: function(task) {
    if (!task.data.source) {
      return false;
    }
    var shouldRun = this.compareParentTask(task, null);
    console.log(shouldRun);
    return shouldRun;

  },

  compareParentTask: function(task, rootTask) {
    if (task.target === 'start' || !task.parent || task.parent.length === 0) {
      return null;
    }

    if (!rootTask) {
      rootTask = task;
    }

    for (var index in task.parent) {
      var parentTask = task.parent[index];

      if (this.compareModTime(rootTask, parentTask) ||
          this.compareParentTask(parentTask, rootTask)) {
        return true;
      }
    }
    return false;
  },

  // true, if sourceTask is newer than targetTask or targetTask is null
  compareModTime: function(sourceTask, targetTask) {
    if (targetTask.target === null || targetTask.target === 'start') {
      return false;
    }

    if (targetTask.data.wr === 'w' && !fs.existsSync(targetTask.target)) {
      console.log(targetTask.target);
      console.log(fs.existsSync(targetTask.target));
      return true;
    }

    var source = fs.statSync(sourceTask.target);
    var target = fs.statSync(targetTask.target);
    if (source.mtime > target.mtime) {
      console.log(target);
      console.log(source);
    }
    return source.ctime > target.ctime;
  },

  scanEdges: function(task) {
    if (task.target === null) {
      return;
    }
    for (var i = 0; i < task.parent.length; i++) {
      var parentTask = task.parent[i];
      if (parentTask.target) {
        this.edges.push([task.target, parentTask.target]);
      }
      this.scanEdges(parentTask);
    }
  },

  exec: function() {
    var self = this;
    //console.log(this.edges);
    dag(this.edges, 4, function(e, next) {
      var task = self.config[e];
      test.execute(task, next);
    }, function(err) {
      //console.log(err);
    });

  },

  onMessage: function(msg) {
    switch(msg.type) {

    }
  }
};

function string_src(filename, string) {
  var src = stream.Readable({ objectMode: true })
  src._read = function () {
    this.push(new gutil.File({ cwd: "", base: "", path: filename,
      contents: new Buffer(string) }))
    this.push(null)
  }
  return src
}

function mergeAppPath(newFolderPath, appPath) {
  var currentPath = path.resolve('./');
  var target = appPath.replace(currentPath, '').replace('apps/', '');
  return currentPath + '/' + newFolderPath + target;
}

gulp.task('clean', function() {
  return gulp.src(['profile', 'build_stage'], { read: false })
    .pipe(rimraf('profile'))
    .pipe(rimraf('build_stage'));
});

gulp.task('configure', function() {
  // start task from start and end task with null deps
  configResult['start'] = {
    deps: [path.resolve('profile')],
    cmd: null,
    wr: null,
    source: false
  };
  var tasks = appList.map(function(app) {
    if (!configResult[path.resolve('profile')]) {
      configResult[path.resolve('profile')] = {
        deps: [path.resolve('profile/' + app)],
        cmd: null,
        wr: null,
        source: false
      };
    } else {
      configResult[path.resolve('profile')]
        .deps.push(path.resolve('profile/' + app));
    }

    if (!configResult[path.resolve('profile/' + app)]) {
      configResult[path.resolve('profile/' + app)] = {
        deps: [path.resolve('build_stage/' + app)],
        cmd: {
          type: 'zip',
          content: path.resolve('build_stage/' + app) + ' ' +
            path.resolve('profile/' + app)
        },
        wr: 'w',
        source: false
      };
    }

    configResult[path.resolve('build_stage/' + app)] = {
      deps: [
        path.resolve('build_stage/' + app + '/shared'), 
        path.resolve('build_stage/' + app + '/style'),
        path.resolve('build_stage/' + app + '/js'),
        path.resolve('build_stage/' + app + '/index.html')
      ],
      cmd: null,
      wr: 'w',
      source: false
    };

    configResult[path.resolve('build_stage/' + app + '/style')] = {
      deps: [path.resolve('apps/' + app + '/style')],
      cmd: {
        type: 'cp',
        content: path.resolve('apps/' + app + '/style') + ' ' +
          path.resolve('build_stage/' + app)
      },
      wr: 'w',
      source: false

    };

    configResult[path.resolve('apps/' + app + '/style')] = {
      deps: [],
      cmd: null,
      wr: 'r',
      source: true
    };

    configResult[path.resolve('build_stage/' + app + '/js')] = {
      deps: [path.resolve('apps/' + app + '/js')],
      cmd: {
        type: 'cp',
        content: path.resolve('apps/' + app + '/js') + ' ' +
          path.resolve('build_stage/' + app)
      },
      wr: 'w',
      source: false
    };

    configResult[path.resolve('apps/' + app + '/js')] = {
      deps: [],
      cmd: null,
      wr: 'r',
      source: true
    };

    configResult[path.resolve('build_stage/' + app + '/index.html')] = {
      deps: [path.resolve('apps/' + app + '/index.html')],
      cmd: {
        type: 'cp',
        content: path.resolve('apps/' + app + '/index.html') + ' ' +
          path.resolve('build_stage/' + app)
      },
      wr: 'w',
      source: false
    };

    configResult[path.resolve('apps/' + app + '/index.html')] = {
      deps: [],
      cmd: null,
      wr: 'r',
      source: true
    };

    return gulp.src(['apps/' + app + '/**/*.html'].concat(ignores))
      .pipe(dom(function() {
        var allScripts = this.querySelectorAll('script');
        var sharedScripts = [];
        // this.querySelectorAll is not an Array type.
        for (var i = 0; i < allScripts.length; i++) {
          if (/^\/shared/.test(allScripts[i].src)) {

            sharedScripts.push(allScripts[i].src);

            configResult[path.resolve('build_stage/' + app + '/' +
              allScripts[i].src)] = {
                deps: [path.resolve('./' + allScripts[i].src)],
                cmd: {
                  type: 'cp',
                  content: path.resolve('./' + allScripts[i].src) + ' ' +
                    path.resolve('build_stage/' + app + '/shared/js')
                },
                wr: 'w',
                source: false
              };
            configResult[path.resolve('./' + allScripts[i].src)] = {
              deps: [],
              cmd: null,
              wr: null,
              source: true
            };
            if (!configResult[path.resolve('build_stage/' + app + '/shared')]) {
              configResult[path.resolve('build_stage/' + app + '/shared')] = {
                deps: [path.resolve('build_stage/' + app + '/' +
                  allScripts[i].src)],
                cmd: null,
                wr: null,
                source: false
              };
            } else {
              configResult[path.resolve('build_stage/' + app + '/shared')].deps
                .push(path.resolve('build_stage/' + app + '/' +
                  allScripts[i].src));
            }
          }
        }
        return this;
      }))
      .pipe(through.obj(function(file, env, cb) {
        //console.log(file.path);
        cb();
      }));
  });

  return merge(tasks);
});

gulp.task('write-config', function() {
  return string_src('config_all.json',
    JSON.stringify(configResult, null ,2))
    .pipe(gulp.dest('./'))
});

gulp.task('build', function() {
  return gulp.src('config_all.json')
    .pipe(through.obj(function(file, enc, cb) {
      var allConfig = JSON.parse(file.contents.toString());
      new Builder(allConfig, cb);
    }));
});


gulp.task('default', function(cb) {
  runSeq('configure', 'write-config', 'build', cb);
});



