type AbsorbLogoProps = {
  className?: string | undefined;
};

export const AbsorbLogo: React.FC<AbsorbLogoProps> = ({
  className,
}: AbsorbLogoProps) => {
  return <img src="/Absorb_Logo.svg" alt="Absorb" className={className}></img>;
};
