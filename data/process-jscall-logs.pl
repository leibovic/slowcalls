#!/usr/bin/perl

use strict;
use warnings;
use Getopt::Long;

my $format = 'basic';
GetOptions("format|f=s" => \$format)
  or die "bad args: $!";

my ($jscalls_file, $timeline_file, $output_dir) = @ARGV;
$jscalls_file ||= "/tmp/minefield.log";
$timeline_file ||= "/tmp/minefield.tl";
$output_dir ||= "/tmp";

open(JSCALLS, "<", $jscalls_file)
  or die "open $jscalls_file: $!";
open(TIMELINE, "<", $timeline_file)
  or die "open $timeline_file: $!";

if ($format eq 'slowcalls') {
    open(BASIC, ">", $output_dir . "/slowcalls.txt")
      or die "create " . $output_dir . "/slowcalls.txt: $!";
    open(HTML, ">", $output_dir . "/slowcalls.html")
      or die "create " . $output_dir. "/slowcalls.html: $!";
    open(SVG, ">", $output_dir . "/slowcalls.svg")
      or die "create " . $output_dir . "/slowcalls.svg: $!";
}

my $timechart_height = 240;

my $start_time;
my $end_time;

# slowcalls globals
my $timeline_buffer;
my $current_toplevel;
my $t0;
my @slowcalls;

my %toplevels;

my %threads;
sub thread_id {
    my ($thread) = @_;
    my $thread_id = $threads{$thread};
    if (! $thread_id) {
        $thread_id = 'T' . (1 + keys %threads);
        $threads{$thread} = $thread_id;
    }
    return $thread_id;
}

my $depth = 0;
my $top_t0;
my %toplevel_times;
while(<JSCALLS>) {
    if (index($_, ": function: ") >= 0) {
        my ($thread, $func_addr, $uri, $lineno, $func_name, $ontrace, $enter, $when) =
          /^(\S+): function: (\S+) (\S+) ([\-\d]+) "(.*?)" (\d+) ([\-\d]+) (\d+)$/;
        next if ! defined $when;

        $start_time ||= $when;
        $end_time = $when;

        if ($enter <= 0) {
            # Function call exit
            --$depth;
        }

        if ($format eq 'basic') {
            my $thread_id = thread_id($thread);
            my $e = ($enter <= 0) ? '<' : '>';
            print "$e$depth  $thread_id $when $func_addr=\"$func_name\" $uri#$lineno $ontrace\n";
            if ($enter <= 0 && $depth == 0) {
                print "\n";
            }
        } elsif ($format eq 'slowcalls') {
            if ($enter > 0) {
                if ($depth == 0) {
                    $current_toplevel = $uri;
                    $top_t0 = $when;
                }
                $t0 = $when;
            }
            if ($enter <= 0 && $depth == 0) {
                my $elapsed = $when - $top_t0;
                $toplevel_times{$current_toplevel} += $elapsed;
            }
            if ($enter <= 0 && @slowcalls > 0) {
                my $elapsed = $when - $t0;
                print BASIC "%s -> \"%s\" elapsed=%.3fms\n", $current_toplevel, $func_name, ${elapsed} / 1000;
                print BASIC "  $_->[2]\n" foreach @slowcalls;

                push @{ $toplevels{$current_toplevel} }, [ $t0, $when, $func_name, [ @slowcalls ] ];

                @slowcalls = ();
            }
        }

        if ($enter > 0) {
            # Function call enter
            ++$depth;
        }
    } elsif ($format eq 'slowcalls' && index($_, ": slowcalls: ") >= 0) {
        # TODO: support below
        # Unrecognized format: 2128107872[100225a00]: slowcalls: 0 resource://gre/modules/XPIProvider.jsm -> file:///Users/dietrich/Library/Application%20Support/Firefox/Profiles/wtjp4fmi.slowcalls/extensions/xulapp@toolness.com/bootstrap.js -> file:///Users/dietrich/Library/Application%20Support/Firefox/Profiles/wtjp4fmi.slowcalls/extensions/xulapp@toolness.com/components/harness.js 1 "(execute)" events-between [   233.60] [   233.74]
        my ($thread, $t0, $t1) = /^(\S+): slowcalls: \S+ \S+ [\-\d]+ ".*?" events-between \[\s*([\d.]+)\] \[\s*([\d.]+)\]$/;
        if (! defined $t1) {
            #die "Unrecognized format: $_";
            next;
        }
        my $thread_id = thread_id($thread);
        my $slowcalls = read_timeline($t0, $t1);
        push @slowcalls, @$slowcalls;
    }
}

if ($format eq 'slowcalls') {
    my $total_elapsed = ($end_time - $start_time) / 1e6;

    print HTML <<'END_HTML';
<head>
<link href="http://ajax.googleapis.com/ajax/libs/jqueryui/1.8/themes/base/jquery-ui.css" rel="stylesheet" type="text/css"/>
<script type='text/javascript' src='http://ajax.googleapis.com/ajax/libs/jquery/1.4/jquery.min.js'></script>
<script type='text/javascript' src='http://ajax.googleapis.com/ajax/libs/jqueryui/1.8/jquery-ui.min.js'></script>
<style>
.ui-accordion
.ui-accordion-header a {
  padding: 0 1.5em;
}
</style>
<script>
var svgDoc;
jQuery(document).ready(function(){
  $('#toplevels').accordion({
    active: false,
    autoHeight: false,
    clearStyle: true,
    collapsible: true,
    icons: { 'header': 'ui-icon-plus', 'headerSelected': 'ui-icon-minus' },
    change: function(event, ui) {
      svgFrame.selectToplevel(ui.newHeader.attr('id'));
    }
  });
  $('.slowcaller').accordion({
    active: false,
    autoHeight: false,
    clearStyle: true,
    collapsible: true
  });
  svgDoc = svgFrame.contentDocument;
});
</script>
</head>
<body>
This is a first cut at a page for investigating extensions that invoke expensive operations (see <a href='https://bugzilla.mozilla.org/show_bug.cgi?id=558200'>bug 558200</a>). It uses the instrumentation from <a href='https://bugzilla.mozilla.org/show_bug.cgi?id=507012'>bug 507012</a> to capture every Javascript function entry and exit, and correlates those with entries in the FunctionTimer timeline log.
<p>
These are all of the top-level scripts that invoked Javascript functions. Expand a script to see all of the functions called within the execution scope of that script where at least one timeline event was logged.
<p>
END_HTML

    my @toplevels = sort { $toplevel_times{$b} <=> $toplevel_times{$a} } keys %toplevels;

    print HTML "A total of $total_elapsed seconds was logged.\n<p>\n";

    print HTML "<iframe id='svgFrame' name='svgFrame' width='100%' height='${timechart_height}px' frameborder='1' src='slowcalls.svg'></iframe>\n";

    print HTML "<div id='toplevels'>\n";
    my $tid = 0;
    for my $toplevel (@toplevels) {
        ++$tid;
        my $funcs = $toplevels{$toplevel};

        # Sum the time spent within this toplevel, by any function that logged a timeline event.
        my $total_elapsed = 0;
        for my $fun (@$funcs) {
            my ($t0, $t1, $func_name, $slowcalls) = @$fun;
            $total_elapsed += $t1 - $t0;
        }

        my $percent = sprintf("%.1f%%", 100 * $total_elapsed / $toplevel_times{$toplevel});
        printf HTML "  <h3 id='T%s'><a href='#'>%s (%.3fms total, %.3fms (%s) within functions that logged timeline events)</a></h3>\n", $tid, $toplevel, $toplevel_times{$toplevel} / 1000, $total_elapsed / 1000, $percent;
        print HTML "  <div class='slowcaller'>\n";
        for my $fun (@$funcs) {
            my ($t0, $t1, $func_name, $slowcalls) = @$fun;
            my $elapsed = $t1 - $t0;
            $_ = ($_ - $start_time) / 1e6 for ($t0, $t1);
            printf HTML ("    <h4><a href='#'>\@%.6f..%.6f<%.3fms> \"%s\": %d slowcalls</a></h4>\n", $t0, $t1, $elapsed / 1000, $func_name, scalar(@$slowcalls));
            print HTML "    <div>\n";
            print HTML "      $_->[2]<br>\n" foreach @$slowcalls;
            print HTML "    </div>\n";
        }
        print HTML "  </div>\n";
    }

    print HTML "</div><!-- toplevels -->\n";

    print HTML <<'END';
TODOs:
<ul>
<li>Activate the specific timeline events
<li>Make a by-event view to add to the by-toplevel view (DB terms: group by event instead of group by toplevel. Maybe I ought to use a DB...)
<li>Add full JS callstacks to the events
<li>Activate the timechart boxes, with cursor keys to walk forward/backward
<li>Eliminate wait time (time between events?)
<li>Annotate graph with the startup markers
<li>Zooming/narrowing (select a subset of the whole time range)
<li>Restrict to certain toplevels
<li>Rationalize what a toplevel is
<li>Hovers
<li>Measure time for a range selection
<li>Generalize
</ul>
<p>
END

    print HTML "</body>\n";

    write_svg($timechart_height, \@toplevels);

    close BASIC;
    print "Wrote /tmp/slowcalls.txt\n";
    close HTML;
    print "Wrote /tmp/slowcalls.html\n";
}

sub write_svg {
    my ($height, $toplevels) = @_;

    my $total_elapsed_us = $end_time - $start_time;
    my $lines = 10;
    my $width = 1600;
    my $top = 0;
    my $label_end = 100;
    my $draw_x0 = $label_end + 5;
    my $pady = 2;

    my $us_per_line = $total_elapsed_us / $lines;

    my %toplevel_gids;

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
    print SVG qq(<text font-family="Verdana" font-size="14" fill="blue" text-anchor="end" y="${top}px">\n);
    my $lineheight = int(($height - $top) / $lines);
    my $boxheight = int($lineheight * 0.7);
    my @starts;
    my $t = 0;
    for (0 .. $lines - 1) {
        push @starts, $t;
        my $tstr = sprintf("+%.6fs", $t / 1e6);
        print SVG "  <tspan x='$label_end' dy='$lineheight'>$tstr</tspan>\n";
        $t += int($us_per_line);
    }
    print SVG "  <tspan></tspan>\n"; # Seems to fix an alignment problem??
    print SVG "</text>\n";

    my $vgap = $boxheight + int(($lineheight - $boxheight) / 2) - $lineheight / 2; # FIXME
    print "lineheight=$lineheight boxheight=$boxheight pady=$pady vgap=$vgap\n";

    my $tid = 0;
    my $gid = 0;
    for my $toplevel (@$toplevels) {
        ++$tid;
        my $funcs = $toplevels{$toplevel};
        for my $fun (@$funcs) {
            my ($t0, $t1, $func_name, $slowcalls) = @$fun;
            $t0 -= $start_time;
            $t1 -= $start_time;
            my $l0 = int($t0 / $us_per_line);
            my $l1 = int($t1 / $us_per_line);
            my $y0 = ($l0 + 0) * $lineheight + $vgap;
            my $y1 = ($l1 + 0) * $lineheight + $vgap;
            my $x0 = $draw_x0 + ($t0 % $us_per_line) / $us_per_line * ($width - $draw_x0);
            my $x1 = $draw_x0 + ($t1 % $us_per_line) / $us_per_line * ($width - $draw_x0);

            ++$gid;
            push @{ $toplevel_gids{"T$tid"} }, "G$gid";

            print SVG "<g id='G$gid' class='tc_default'>\n";
            if ($y0 == $y1) {
                my $w = $x1 - $x0;
                print SVG "<rect x='$x0' y='$y0' width='$w' height='$boxheight' />\n";
            } else {
                my $w = $width - $x0;
                print SVG "<rect x='$x0' y='$y0' width='$w' height='$boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
                for my $line ($l0 + 1 .. $l1 - 1) {
                    my $y = $line * $lineheight + $vgap;
                    print SVG "<rect x='$draw_x0' y='$y' width='$width' height='$boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
                }
                $w = $x1 - $draw_x0;
                print SVG "<rect x='$draw_x0' y='$y0' width='$w' height='$boxheight' fill='yellow' stroke='green' stroke-width='2px' />\n";
            }
            print SVG "</g>\n";
        }
    }

    print SVG "<script><![CDATA[\n";
    while (my ($tid, $gids) = each %toplevel_gids) {
        print SVG "toplevel_gids['$tid'] = [" . join(", ", map { "'$_'" } @$gids) . "];\n";
    }
    print SVG "]]></script>\n";

    print SVG "</svg>\n";
    print "Wrote slowcalls.svg\n";
}

sub read_line {
    my ($fh, $bufref) = @_;
    if (defined $$bufref) {
        my $temp = $$bufref;
        undef $$bufref;
        return $temp;
    } else {
        return scalar(<$fh>);
    }
}

sub read_timeline {
    my ($t0, $t1) = @_;
    my @slowcalls;
    local $_;
    while (defined($_ = read_line(\*TIMELINE, \$timeline_buffer))) {
        chomp;
        
        # FIXME: The timestamp used is the leave timestamp, which
        # means things could be out of order. Also, we really want to
        # keep the mark events.

        my ($t, $depth, $elapsed, $event) =
          /^\[\s*([\d\.]+)\] \s+ < \s+       # [   255.29] <
           \(\s*(\d+)\)\s*                   # ( 15)
           \|                                # |
           (?:.*?MINMS)?[^\(]*               # <MINMS      0.01 ms
           \(\s*([\d\.]+) \s+ ms \s+ total\) # (    0.01 ms total)
           \s+ - \s+
           (.*)                              # virtual kaboom()...
           $/x
          or next; # Skip enters and marks
        if ($t > $t1) {
            $timeline_buffer = $_;
            last;
        }
        if ($t >= $t0) {
            chomp;
            push @slowcalls, [ $t, $depth, $event ];
        }
    }
    return \@slowcalls;
}
