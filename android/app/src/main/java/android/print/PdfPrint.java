package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

import java.io.File;

/**
 * Writes a WebView's print output straight to a PDF file, without the print dialog.
 * Lives in android.print because the layout/write callbacks have package-private constructors — the standard way to
 * drive PrintDocumentAdapter from app code.
 */
public final class PdfPrint {
    public interface Done { void done(String error); }

    private PdfPrint() { }

    public static void write(final PrintDocumentAdapter adapter, PrintAttributes attrs, final File out, final Done cb) {
        adapter.onStart();
        adapter.onLayout(null, attrs, null, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                final ParcelFileDescriptor fd;
                try {
                    out.getParentFile().mkdirs();
                    fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE
                            | ParcelFileDescriptor.MODE_READ_WRITE);
                } catch (Exception e) {
                    cb.done("Couldn't create the file.");
                    return;
                }
                try {
                adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, fd, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        close(fd);
                        adapter.onFinish();
                        cb.done(null);
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        close(fd);
                        adapter.onFinish();
                        cb.done(error == null ? "Writing the PDF failed." : error.toString());
                    }
                });
                } catch (Throwable t) {
                    close(fd);
                    cb.done("Writing the PDF failed (" + t.getClass().getSimpleName() + ").");
                }
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                cb.done(error == null ? "Laying out the PDF failed." : error.toString());
            }
        }, null);
    }

    private static void close(ParcelFileDescriptor fd) {
        try { fd.close(); } catch (Exception ignored) { }
    }
}
