import { QRCodeCanvas } from 'qrcode.react';

export function QrPanel({ value, label, variant }: { value: string; label?: string; variant?: 'default' | 'attract' }) {
  const rootClass = variant === 'attract' ? 'qr-panel attract' : 'qr-panel';
  return (
    <div className={rootClass}>
      <QRCodeCanvas value={value} size={178} includeMargin bgColor="#f7f0dc" fgColor="#151716" />
      <div className="qr-copy">
        <strong>{label ?? 'Scan to control'}</strong>
        <span>{value}</span>
      </div>
    </div>
  );
}
