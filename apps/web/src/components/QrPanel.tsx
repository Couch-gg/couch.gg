import { QRCodeCanvas } from 'qrcode.react';

export function QrPanel({ value }: { value: string }) {
  return (
    <div className="qr-panel">
      <QRCodeCanvas value={value} size={178} includeMargin bgColor="#f7f0dc" fgColor="#151716" />
      <div className="qr-copy">
        <strong>Scan to control</strong>
        <span>{value}</span>
      </div>
    </div>
  );
}
