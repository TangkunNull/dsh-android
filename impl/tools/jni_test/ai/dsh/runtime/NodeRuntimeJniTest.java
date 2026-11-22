package ai.dsh.runtime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Drives the JNI bridge from a real JVM. One case per process: libnode cannot be
 * started twice in the same process (V8 tears down its platform on exit and a
 * second start crashes), so this is invoked once per case by test_jni_host.sh.
 *
 * <p>Results go to a file, not to stdout: the runner redirects fd 1 and fd 2 to
 * capture the child's output, so anything the JVM prints after start() would be
 * swallowed by the capture — and would then look like the runtime had emitted
 * it. Writing to a file keeps the two channels honestly separate.
 *
 * <p>Usage: NodeRuntimeJniTest &lt;lib.so&gt; &lt;case&gt; &lt;workdir&gt;
 */
public final class NodeRuntimeJniTest {

    private static int failures = 0;
    private static final StringBuilder report = new StringBuilder();
    private static final List<String> out = Collections.synchronizedList(new ArrayList<>());
    private static final List<String> err = Collections.synchronizedList(new ArrayList<>());
    private static volatile Integer exitCode = null;
    private static Path reportPath;

    private static void say(String text) {
        report.append(text).append('\n');
    }

    private static void check(String what, boolean ok, String detail) {
        say((ok ? "  ok    " : "  FAIL  ") + what + (detail.isEmpty() ? "" : ": " + detail));
        if (!ok) failures++;
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: NodeRuntimeJniTest <lib.so> <case> <workdir>");
            System.exit(2);
        }
        Path work = Paths.get(args[2]).toAbsolutePath();
        Files.createDirectories(work);
        reportPath = work.resolve("report.txt");

        System.load(Paths.get(args[0]).toAbsolutePath().toString());
        int testCase = Integer.parseInt(args[1]);

        try {
            switch (testCase) {
                case 1 -> casePrint(work);
                case 2 -> caseArgv(work);
                case 3 -> caseStop(work);
                default -> {
                    System.err.println("unknown case " + testCase);
                    System.exit(2);
                }
            }
        } finally {
            say("");
            say((failures == 0 ? "PASS" : "FAIL") + " case " + testCase
                    + ", " + failures + " failure(s)");
            Files.writeString(reportPath, report.toString(), StandardCharsets.UTF_8);
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // --------------------------------------------------------------- cases ----

    /** console.log arrives as a Java String, with non-ASCII intact. */
    private static void casePrint(Path work) throws Exception {
        say("=== case 1 (jni print) ===");
        Path script = write(work, "print.js",
                "console.log('hello from libnode 42');\n"
              + "console.log('emoji 😀 中文 ünïcode');\n");
        start(script.toString(), work);

        int code = NodeRuntime.nativeJoin();
        check("join returns 0", code == 0, "got " + code);
        check("stdout has exactly 2 lines", out.size() == 2, String.valueOf(out));
        check("ascii line intact", out.size() > 0 && out.get(0).equals("hello from libnode 42"),
                out.isEmpty() ? "(none)" : out.get(0));
        // The interesting one: UTF-8 -> UTF-16. A surrogate-pair bug shows up here
        // as '?' or as a mangled pair, and nowhere else.
        check("emoji survives UTF-8 -> UTF-16",
                out.size() > 1 && out.get(1).equals("emoji 😀 中文 ünïcode"),
                out.size() > 1 ? out.get(1) : "(none)");
        check("nothing on stderr", err.isEmpty(), String.valueOf(err));
    }

    /** argv/env/cwd reach node through the JNI marshalling. */
    private static void caseArgv(Path work) throws Exception {
        say("=== case 2 (jni argv) ===");
        Path script = write(work, "argv.js",
                "console.log(JSON.stringify(process.argv));\n"
              + "console.log(process.env.DSH_JNI_MARK || 'no-env');\n"
              + "console.log(process.cwd());\n");
        start(script.toString(), work, "a b", "c\\d");

        int code = NodeRuntime.nativeJoin();
        check("join returns 0", code == 0, "got " + code);
        check("three lines", out.size() == 3, String.valueOf(out));
        String argvLine = out.size() > 0 ? out.get(0) : "";
        // argv[0] is the host executable (java here, the app process on Android);
        // what matters is that the script and its arguments survived the trip.
        check("script path present", argvLine.contains(script.toString()), argvLine);
        check("arg with a space intact", argvLine.contains("\"a b\""), argvLine);
        check("arg with a backslash intact", argvLine.contains("c\\\\d"), argvLine);
        check("separator '--' was consumed", !argvLine.contains("\"--\""), argvLine);
        check("env var reached node", out.size() > 1 && out.get(1).equals("from-java"),
                out.size() > 1 ? out.get(1) : "(none)");
        check("cwd applied", out.size() > 2 && out.get(2).equals(work.toString()),
                out.size() > 2 ? out.get(2) : "(none)");
    }

    /** stop() breaks a running loop and join() returns promptly with 0. */
    private static void caseStop(Path work) throws Exception {
        say("=== case 3 (jni stop) ===");
        Path script = write(work, "loop.js",
                "let n = 0;\n"
              + "const t = setInterval(() => { console.log('tick ' + (++n)); }, 100);\n"
              + "setTimeout(() => { console.log('never'); }, 60000);\n"
              + "process.on('SIGTERM', () => clearInterval(t));\n");
        start(script.toString(), work);
        check("isRunning while looping", NodeRuntime.nativeIsRunning(), "");

        Thread.sleep(400);
        long t0 = System.nanoTime();
        NodeRuntime.nativeStop();
        int code = NodeRuntime.nativeJoin();
        long ms = (System.nanoTime() - t0) / 1_000_000;

        check("join returns 0 after stop", code == 0, "got " + code);
        check("stopped within 2s", ms < 2000, ms + " ms");
        check("some ticks arrived", out.size() >= 2, String.valueOf(out.size()));
        check("not running after join", !NodeRuntime.nativeIsRunning(), "");
        check("exit callback fired", exitCode != null, "exitCode=" + exitCode);
    }

    // -------------------------------------------------------------- helpers ---

    private static void start(String script, Path work, String... scriptArgs) {
        List<String> argv = new ArrayList<>();
        argv.add("node");
        argv.add(script);
        argv.add("--");
        Collections.addAll(argv, scriptArgs);

        String[] env = {
                "HOME=" + work,
                "DSH_JNI_MARK=from-java",
        };
        boolean ok = NodeRuntime.nativeStart(
                argv.toArray(new String[0]), env, work.toString(),
                new NodeRuntime.Callback() {
                    @Override
                    public void onOutput(String line, boolean isStderr) {
                        (isStderr ? err : out).add(line);
                    }

                    @Override
                    public void onExit(int code) {
                        exitCode = code;
                    }
                });
        check("nativeStart returned true", ok, "");
    }

    private static Path write(Path dir, String name, String body) throws IOException {
        Path p = dir.resolve(name);
        Files.writeString(p, body, StandardCharsets.UTF_8);
        return p;
    }
}
