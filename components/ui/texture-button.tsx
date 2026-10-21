'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import './texture-button.css';

const textureVariants=cva('texture-button',{
  variants:{
    variant:{primary:'texture-primary',accent:'texture-accent',secondary:'texture-secondary',destructive:'texture-destructive',minimal:'texture-minimal',icon:'texture-icon'},
    size:{sm:'texture-sm',default:'texture-default',lg:'texture-lg',icon:'texture-size-icon'},
  },defaultVariants:{variant:'primary',size:'default'},
});
export interface TextureButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>,VariantProps<typeof textureVariants>{asChild?:boolean;}

/** Tactile layered button adapted from the supplied Cult UI component.
 * asChild keeps the actual link as the interactive element and preserves its props.
 */
export const TextureButton=React.forwardRef<HTMLButtonElement,TextureButtonProps>(function TextureButton({children,variant='primary',size='default',asChild=false,className,type,disabled,...props},ref){
  const classes=textureVariants({variant,size,className});
  if(asChild){
    const child=React.Children.only(children) as React.ReactElement<{children?:React.ReactNode}>;
    return <Slot className={classes} ref={ref} {...props} aria-disabled={disabled||undefined} data-disabled={disabled||undefined} tabIndex={disabled?-1:props.tabIndex} onClick={disabled?event=>{event.preventDefault();event.stopPropagation();}:props.onClick}>{React.cloneElement(child,undefined,<span className="texture-button__inner">{child.props.children}</span>)}</Slot>;
  }
  return <button className={classes} ref={ref} type={type??'button'} disabled={disabled} {...props}><span className="texture-button__inner">{children}</span></button>;
});
