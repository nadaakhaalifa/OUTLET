/** Structural copy of `PictureData` from @outlet/media (type only: the web app must not import the sharp-based runtime). */
export interface PictureSource {
  readonly type: string;
  readonly srcset: string;
  readonly sizes: string;
}
export interface PictureData {
  readonly sources: readonly PictureSource[];
  readonly img: { readonly src: string; readonly srcset: string; readonly sizes: string; readonly width: number; readonly height: number };
}

export interface ArtImage {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  /** AVIF/WebP/JPEG renditions from `srcset()` of @outlet/media. */
  readonly picture?: PictureData;
}

export interface PictureProps {
  readonly image: ArtImage;
  readonly className?: string;
  /** True only for the LCP image: eager load and high fetch priority. */
  readonly priority?: boolean;
  /** Fallback intrinsic size (CLS) when the image has none. */
  readonly fallbackSize?: { readonly width: number; readonly height: number };
}

export function Picture({ image, className, priority = false, fallbackSize = { width: 400, height: 400 } }: PictureProps) {
  const loading = priority ? "eager" : "lazy";
  const fetchPriority = priority ? "high" : "auto";
  if (image.picture) {
    const { img, sources } = image.picture;
    return (
      <picture>
        {sources.map((s) => (
          <source key={s.type} type={s.type} srcSet={s.srcset} sizes={s.sizes} />
        ))}
        <img src={img.src} srcSet={img.srcset} sizes={img.sizes} width={img.width} height={img.height} alt={image.alt} loading={loading} fetchPriority={fetchPriority} decoding="async" {...(className ? { className } : {})} />
      </picture>
    );
  }
  return (
    <img src={image.src} width={image.width ?? fallbackSize.width} height={image.height ?? fallbackSize.height} alt={image.alt} loading={loading} fetchPriority={fetchPriority} decoding="async" {...(className ? { className } : {})} />
  );
}
