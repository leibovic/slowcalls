function generate(jscalls_file, timeline_file, output_dir) {

  jscalls_file ||= "/tmp/minefield.log";
  timeline_file ||= "/tmp/minefield.tl";
  output_dir ||= "/tmp";

  open(JSCALLS, "<", jscalls_file)
    or die "open jscalls_file: !";
  open(TIMELINE, "<", timeline_file)
    or die "open timeline_file: !";

  if (format eq 'slowcalls') {
      open(BASIC, ">", output_dir . "/slowcalls.txt")
        or die "create " . output_dir . "/slowcalls.txt: !";
      open(HTML, ">", output_dir . "/slowcalls.html")
        or die "create " . output_dir. "/slowcalls.html: !";
      open(SVG, ">", output_dir . "/slowcalls.svg")
        or die "create " . output_dir . "/slowcalls.svg: !";
  }

  var timechart_height = 240;

  var start_time;
  var end_time;

  // slowcalls globals
  var timeline_buffer;
  var current_toplevel;
  var t0;
  var slowcalls;

  var toplevels = {};

  var threads = {};
  function thread_id(thread) {
      var thread_id = threads[thread];
      if (!thread_id) {
          thread_id = 'T' + (1 + keys %threads);
          threads[thread] = thread_id;
      }
      return thread_id;
  }

  var depth = 0;
  var top_t0;
  var %toplevel_times;
  while(<JSCALLS>) {
      if (index(_, ": function: ") >= 0) {
          var (thread, func_addr, uri, lineno, func_name, ontrace, enter, when) =
            /^(\S+): function: (\S+) (\S+) ([\-\d]+) "(.*?)" (\d+) ([\-\d]+) (\d+)/;
          next if ! defined when;

          start_time ||= when;
          end_time = when;

          if (enter <= 0) {
              // Function call exit
              --depth;
          }

          if (format eq 'basic') {
              var thread_id = thread_id(thread);
              var e = (enter <= 0) ? '<' : '>';
              print "edepth  thread_id when func_addr=\"func_name\" uri#lineno ontrace\n";
              if (enter <= 0 && depth == 0) {
                  print "\n";
              }
          } elsif (format eq 'slowcalls') {
              if (enter > 0) {
                  if (depth == 0) {
                      current_toplevel = uri;
                      top_t0 = when;
                  }
                  t0 = when;
              }
              if (enter <= 0 && depth == 0) {
                  var elapsed = when - top_t0;
                  toplevel_times{current_toplevel} += elapsed;
              }
              if (enter <= 0 && @slowcalls > 0) {
                  var elapsed = when - t0;
                  print BASIC "%s -> \"%s\" elapsed=%.3fms\n", current_toplevel, func_name, {elapsed} / 1000;
                  print BASIC "  _->[2]\n" foreach @slowcalls;

                  push @{ toplevels{current_toplevel} }, [ t0, when, func_name, [ @slowcalls ] ];

                  @slowcalls = ();
              }
          }

          if (enter > 0) {
              // Function call enter
              ++depth;
          }
      } elsif (format eq 'slowcalls' && index(_, ": slowcalls: ") >= 0) {
          // TODO: support below
          // Unrecognized format: 2128107872[100225a00]: slowcalls: 0 resource://gre/modules/XPIProvider.jsm -> file:///Users/dietrich/Library/Application%20Support/Firefox/Profiles/wtjp4fmi.slowcalls/extensions/xulapp@toolness.com/bootstrap.js -> file:///Users/dietrich/Library/Application%20Support/Firefox/Profiles/wtjp4fmi.slowcalls/extensions/xulapp@toolness.com/components/harness.js 1 "(execute)" events-between [   233.60] [   233.74]
          var (thread, t0, t1) = /^(\S+): slowcalls: \S+ \S+ [\-\d]+ ".*?" events-between \[\s*([\d.]+)\] \[\s*([\d.]+)\]/;
          if (! defined t1) {
              //die "Unrecognized format: _";
              next;
          }
          var thread_id = thread_id(thread);
          var slowcalls = read_timeline(t0, t1);
          push @slowcalls, @slowcalls;
      }
  }

  if (format eq 'slowcalls') {
      var total_elapsed = (end_time - start_time) / 1e6;

      print HTML <<'END_HTML';
      END_HTML

      var @toplevels = sort { toplevel_times{b} <=> toplevel_times{a} } keys %toplevels;

      print HTML "A total of total_elapsed seconds was logged.\n<p>\n";

      print HTML "<iframe id='svgFrame' name='svgFrame' width='100%' height='{timechart_height}px' frameborder='1' src='slowcalls.svg'></iframe>\n";

      print HTML "<div id='toplevels'>\n";
      var tid = 0;
      for var toplevel (@toplevels) {
          ++tid;
          var funcs = toplevels{toplevel};

          // Sum the time spent within this toplevel, by any function that logged a timeline event.
          var total_elapsed = 0;
          for var fun (@funcs) {
              var (t0, t1, func_name, slowcalls) = @fun;
              total_elapsed += t1 - t0;
          }

          var percent = sprintf("%.1f%%", 100 * total_elapsed / toplevel_times{toplevel});
          printf HTML "  <h3 id='T%s'><a href='#'>%s (%.3fms total, %.3fms (%s) within functions that logged timeline events)</a></h3>\n", tid, toplevel, toplevel_times{toplevel} / 1000, total_elapsed / 1000, percent;
          print HTML "  <div class='slowcaller'>\n";
          for var fun (@funcs) {
              var (t0, t1, func_name, slowcalls) = @fun;
              var elapsed = t1 - t0;
              _ = (_ - start_time) / 1e6 for (t0, t1);
              printf HTML ("    <h4><a href='#'>\@%.6f..%.6f<%.3fms> \"%s\": %d slowcalls</a></h4>\n", t0, t1, elapsed / 1000, func_name, scalar(@slowcalls));
              print HTML "    <div>\n";
              print HTML "      _->[2]<br>\n" foreach @slowcalls;
              print HTML "    </div>\n";
          }
          print HTML "  </div>\n";
      }

      print HTML "</div><!-- toplevels -->\n";

      print HTML <<'END';


      print HTML "</body>\n";

      write_svg(timechart_height, \@toplevels);

      close BASIC;
      print "Wrote /tmp/slowcalls.txt\n";
      close HTML;
      print "Wrote /tmp/slowcalls.html\n";
  }
}

function write_svg {
  var (height, toplevels) = @_;

  var total_elapsed_us = end_time - start_time;
  var lines = 10;
  var width = 1600;
  var top = 0;
  var label_end = 100;
  var draw_x0 = label_end + 5;
  var pady = 2;

  var us_per_line = total_elapsed_us / lines;

  var %toplevel_gids;

  print SVG <<"END";
  <?xml version="1.0" standalone="no"?>
  <svg version="1.1" baseProfile="full"
    width="100%" height="100%"
    onload='startup(evt)'
    xmlns="http://www.w3.org/2000/svg"
    xmlns:xlink="http://www.w3.org/1999/xlink">
  <script><![CDATA[
  var svgDoc;
  var dummy;
  function startup(evt) {
    svgDoc = evt.target.ownerDocument;
  };
  var active;
  var toplevel_gids = {};
  function setGidClass(gid, classname) {
    var l = svgDoc.querySelectorAll("#" + gid);
    for (var i = 0; i < l.length; i++) {
      l[i].setAttribute("class", classname);
    }
  };
  var selected_tid;
  function selectToplevel(tid) {
    if (selected_tid) {
      if (selected_tid === tid) {
        return;
      }
      setToplevelClass(selected_tid, 'tc_default');
    }
    selected_tid = tid;
    if (selected_tid) {
      setToplevelClass(selected_tid, 'tc_active');
    }
  }

  function setToplevelClass(tid, classname) {
    var gids = toplevel_gids[tid];
    for (var i = 0; i < gids.length; i++) {
      setGidClass(gids[i], classname);
    }
  };
  ]]></script>
  <desc>Timechart</desc>
  <style><![CDATA[
    g.tc_default rect {
      fill: yellow;
      stroke: green;
      stroke-width: 1px;
    }
    g.tc_active rect {
      fill: orange;
      stroke: red;
      stroke-width: 2px;
    }
  ]]></style>
  END

  print SVG "<!-- time labels -->\n";
  print SVG qq(<text font-family="Verdana" font-size="14" fill="blue" text-anchor="end" y="{top}px">\n);
  var lineheight = int((height - top) / lines);
  var boxheight = int(lineheight * 0.7);
  var @starts;
  var t = 0;
  for (0 .. lines - 1) {
    push @starts, t;
    var tstr = sprintf("+%.6fs", t / 1e6);
    print SVG "  <tspan x='label_end' dy='lineheight'>tstr</tspan>\n";
    t += int(us_per_line);
  }
  print SVG "  <tspan></tspan>\n"; // Seems to fix an alignment problem??
  print SVG "</text>\n";

  var vgap = boxheight + int((lineheight - boxheight) / 2) - lineheight / 2; // FIXME
  print "lineheight=lineheight boxheight=boxheight pady=pady vgap=vgap\n";

  var tid = 0;
  var gid = 0;
  for var toplevel (@toplevels) {
      ++tid;
      var funcs = toplevels{toplevel};
      for var fun (@funcs) {
          var (t0, t1, func_name, slowcalls) = @fun;
          t0 -= start_time;
          t1 -= start_time;
          var l0 = int(t0 / us_per_line);
          var l1 = int(t1 / us_per_line);
          var y0 = (l0 + 0) * lineheight + vgap;
          var y1 = (l1 + 0) * lineheight + vgap;
          var x0 = draw_x0 + (t0 % us_per_line) / us_per_line * (width - draw_x0);
          var x1 = draw_x0 + (t1 % us_per_line) / us_per_line * (width - draw_x0);

          ++gid;
          push @{ toplevel_gids{"Ttid"} }, "Ggid";

          print SVG "<g id='Ggid' class='tc_default'>\n";
          if (y0 == y1) {
              var w = x1 - x0;
              print SVG "<rect x='x0' y='y0' width='w' height='boxheight' />\n";
          } else {
              var w = width - x0;
              print SVG "<rect x='x0' y='y0' width='w' height='boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
              for var line (l0 + 1 .. l1 - 1) {
                  var y = line * lineheight + vgap;
                  print SVG "<rect x='draw_x0' y='y' width='width' height='boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
              }
              w = x1 - draw_x0;
              print SVG "<rect x='draw_x0' y='y0' width='w' height='boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
          }
          print SVG "</g>\n";
      }
  }

  print SVG "<script><![CDATA[\n";
  while (var (tid, gids) = each %toplevel_gids) {
      print SVG "toplevel_gids['tid'] = [" . join(", ", map { "'_'" } @gids) . "];\n";
  }
  print SVG "]]></script>\n";

  print SVG "</svg>\n";
  print "Wrote slowcalls.svg\n";
}

function read_line() {
    var (fh, bufref) = @_;
    if (defined bufref) {
        var temp = bufref;
        undef bufref;
        return temp;
    } else {
        return scalar(<fh>);
    }
}

function read_timeline() {
    var (t0, t1) = @_;
    var @slowcalls;
    local _;
    while (defined(_ = read_line(\*TIMELINE, \timeline_buffer))) {
        chomp;
        
        // FIXME: The timestamp used is the leave timestamp, which
        // means things could be out of order. Also, we really want to
        // keep the mark events.

        var (t, depth, elapsed, event) =
          /^\[\s*([\d\.]+)\] \s+ < \s+       // [   255.29] <
           \(\s*(\d+)\)\s*                   // ( 15)
           \|                                // |
           (?:.*?MINMS)?[^\(]*               // <MINMS      0.01 ms
           \(\s*([\d\.]+) \s+ ms \s+ total\) // (    0.01 ms total)
           \s+ - \s+
           (.*)                              // virtual kaboom()...
           /x
          or next; // Skip enters and marks
        if (t > t1) {
            timeline_buffer = _;
            last;
        }
        if (t >= t0) {
            chomp;
            push @slowcalls, [ t, depth, event ];
        }
    }
    return \@slowcalls;
}
