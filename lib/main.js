/*

Phase 1: Given a build w/ all patches applied and this add-on installed
be able to click the button, app restarts, and profiling begins on restart.
Click on button again to turn off profiling, restart app and view
visualization of correlation of function timer calls with event loop lag
occurrences.

Phase 2: Add the ability to start/stop recording, with same restart->restart
approach. On restart, slice the logs to only the "recorded" part, and show
visualization of that.

Bonus: Add a button to execute sfink's slowcalls viz.
*/

const {Cc, Ci, Cu, Cm} = require('chrome');
Cu.import('resource://gre/modules/NetUtil.jsm', this);
Cu.import('resource://gre/modules/Services.jsm', this);
Cu.import('resource://gre/modules/FileUtils.jsm', this);

// so we can include scripts
let vizDir = 'ProfD';
// so they get cleaned up
let logDir = 'TmpD';

// Env vars required for the logging
let vars = {
  MOZ_INSTRUMENT_EVENT_LOOP: 1,
  MOZ_INSTRUMENT_EVENT_LOOP_OUTPUT: FileUtils.getFile(logDir, ['slowevents.log']).path,
  NSPR_LOG_MODULES: 'SlowCalls:5',
  NSPR_LOG_FILE: FileUtils.getFile(logDir, ['slowcalls.log']).path,
  MOZ_FT: FileUtils.getFile(logDir, ['function-timeline.log']).path
};

// read a file fully into memory, pass data as string to callback
function readFile(file, callback) {
  NetUtil.asyncFetch(file, function (inputStream, statusCode, request) {
    let data = NetUtil.readInputStreamToString(inputStream,
                                               inputStream.available());
    callback(statusCode, data);
  });
}

// execute a system command, callback func for notification when finished
// ** DANGER WILL ROBINSON! **
function executeSystemCommand(args, callback) {
  if (!args.length)
    return;
  let cmd = args.shift();
  let executable = (Cc['@mozilla.org/file/local;1'].
                    createInstance(Ci.nsILocalFile));
  executable.initWithPath(cmd);
  try {
    let process = Cc["@mozilla.org/process/util;1"].
                  createInstance(Ci.nsIProcess);
    process.init(executable);
    process.runAsync(args, args.length, {
      observe: callback
    });
  } catch (e) {
    Cu.reportError(e);
    throw new Error("Error running editor : " + e);
    return null;
  }
}

// restart firefox
function restart() {
  let cancelQuit = Cc['@mozilla.org/supports-PRBool;1'].
                   createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancelQuit, 'quit-application-requested', 'restart');

  if (!cancelQuit.data) {
    let appStartup = Cc['@mozilla.org/toolkit/app-startup;1'].
                     getService(Ci.nsIAppStartup);
    appStartup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    return true;
  }
  return false;
}

// toggle the env vars for logging
function toggleEnvVars() {
  let env = Cc["@mozilla.org/process/environment;1"].
            getService(Ci.nsIEnvironment);

  for (let [name, value] in Iterator(vars)) {
    let old = env.get(name);
    console.log('set ', name, ' from ', old, ' to ', old ? 0 : value);
    env.set(name, env.get(name) ? 0 : value);
  }
}

// add-on bar button for restarting in profiler mode
require('widget').Widget({
  id: 'restartInProfileMode',
  label: 'Restart in Profile Mode',
  contentURL: 'data:text/plain,P',
  onClick: function onClick() {
    toggleEnvVars();
    restart();
  }
});

function slowcalls() {
  // first, load perl script into string, copy to known location
  // because damn we can't get an nsifile to these obscure fucking
  // directories jetpack compiles into.
  let data = require('self').data.load('process-jscall-logs.pl');
  let file = FileUtils.getFile('CurProcD', ['process-jscall-logs.pl']);
  if (file.exists())
    file.remove(false);
  var ostream = FileUtils.openSafeFileOutputStream(file)
  var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                  createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  var istream = converter.convertToInputStream(data);

  NetUtil.asyncCopy(istream, ostream, function(status) {
    if (status !== 0) {
      console.log('FAILED TO COPY');
      return;
    }

    // execute script
    try {
      let cmd = [
        '/opt/local/bin/perl',
        file.path,
        '-f',
        'slowcalls',
        vars.NSPR_LOG_FILE,
        vars.MOZ_FT,
        FileUtils.getFile(vizDir, []).path
      ];

      console.log('executing ', cmd.join(' '));
      executeSystemCommand(cmd, function() {
        let fileURL = Services.io.newFileURI(FileUtils.getFile(vizDir, ['slowcalls.html']) , null, null).spec;
        require('tabs').open(fileURL);
      });
    }
    catch(ex) {
      console.log(ex);
    }
  });
}

// add-on bar button for processing slowcalls logs and loading viz
require('widget').Widget({
  id: 'slowcalls',
  label: 'slowcalls',
  contentURL: 'data:text/plain,SC',
  onClick: function onClick() {
    slowcalls();
  }
});
