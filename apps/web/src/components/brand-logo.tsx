import Image from 'next/image';

export default function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'brand-logo brand-logo-compact' : 'brand-logo'}>
      <Image src="/brand/logo-icon-transparent.png" alt="" width={38} height={38} priority />
      <span className="brand-logo-name">CareerScope</span>
    </span>
  );
}
