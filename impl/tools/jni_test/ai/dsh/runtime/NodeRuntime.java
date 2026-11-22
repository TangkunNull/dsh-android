package ai.dsh.runtime;

/**
 * Stand-in for the Kotlin {@code object NodeRuntime}, used only by the host JNI
 * test.
 *
 * <p>The native library resolves entry points by the fully-qualified class name,
 * so this class must be called {@code ai.dsh.runtime.NodeRuntime} and declare
 * the same four methods. Kotlin compiles the object's {@code external fun}s into
 * instance methods on a singleton while this declares them static — both arrive
 * as a jclass/jobject handle in the same slot, so the symbols match either way.
 *
 * <p>Why bother: it proves that the bridge marshals arguments, attaches the
 * reader threads and delivers callbacks through a real JVM, which the host
 * runner test (JNI-free) cannot show.
 */
public final class NodeRuntime {
    private NodeRuntime() {}

    public interface Callback {
        void onOutput(String line, boolean isStderr);
        void onExit(int code);
    }

    public static native boolean nativeStart(
            String[] argv, String[] env, String cwd, Callback callback);

    public static native void nativeStop();

    public static native boolean nativeIsRunning();

    public static native int nativeJoin();
}
