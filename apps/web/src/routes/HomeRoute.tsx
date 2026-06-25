import { AttractHome } from '../components/AttractHome.js';
import { isPhone } from '../device.js';

export function HomeRoute({ navigate }: { navigate: (to: string) => void }) {
  if (isPhone()) return <ScanPrompt />;
  return <AttractHome navigate={navigate} />;
}

/**
 * Phone landing for the bare "/" route. Phones are controllers only, so the
 * next step is always to open couch.gg on a shared screen and scan its QR code.
 */
function ScanPrompt() {
  return (
    <main className="scan-prompt">
      <section className="scan-prompt-card">
        <div className="brand-row small">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <h1 className="scan-prompt-title">Scan a TV to begin</h1>
        <p className="scan-prompt-body">
          Open couch.gg on your TV, laptop, or shared screen. Then scan the QR code here with this phone.
        </p>
      </section>
    </main>
  );
}
