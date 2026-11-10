export function Brand({ subtitle = 'CUSTOMER SUPPORT', className = '' }: Readonly<{ subtitle?: string; className?: string }>) {
  return <div className={`portal-brand ${className}`}><img className="bmw-roundel" src="/brand/bmw-logo.png" alt="BMW" width="48" height="48" /><span className="brand-divider" /><span>Overdrive<small>{subtitle}</small></span></div>;
}