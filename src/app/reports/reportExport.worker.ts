/// <reference lib="webworker" />
import { createReportPdf, createReportXlsx } from '../../utils/reportExports.js';
import type { ReportDocument } from '../../utils/reportTypes';

self.onmessage = async (event: MessageEvent<{ format: 'pdf' | 'xlsx'; report: ReportDocument }>) => {
  try {
    const { format, report } = event.data;
    if (format !== 'pdf' && format !== 'xlsx') throw new Error('Choose PDF or Excel.');
    let bytes: Uint8Array;
    if (format === 'pdf') {
      const fontResponses = await Promise.all([
        fetch('/report-fonts/NotoSans-Regular.ttf', { cache: 'force-cache' }),
        fetch('/report-fonts/NotoSans-Bold.ttf', { cache: 'force-cache' }),
      ]);
      if (fontResponses.some((response) => !response.ok)) throw new Error('The PDF fonts could not be loaded. Please retry the download.');
      const [fontBytes, boldFontBytes] = await Promise.all(fontResponses.map((response) => response.arrayBuffer()));
      bytes = await createReportPdf(report, { fontBytes: new Uint8Array(fontBytes), boldFontBytes: new Uint8Array(boldFontBytes) });
    } else bytes = await createReportXlsx(report);
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'The file could not be created. Please try again.' });
  }
};
export {};
