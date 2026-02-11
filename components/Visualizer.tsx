import React, { useEffect, useRef } from 'react';
import { AudioVisualizerProps } from '../types';

export const Visualizer: React.FC<AudioVisualizerProps> = ({ isPlaying, volume }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Initializing with null to satisfy TypeScript requirement for an initial argument
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;

    const render = () => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;

      // Base radius plus volume effect
      const baseRadius = 60;
      // Smooth the volume visual
      const dynamicRadius = baseRadius + (volume * 50);

      // Draw glowing orb
      const gradient = ctx.createRadialGradient(centerX, centerY, baseRadius * 0.5, centerX, centerY, dynamicRadius * 1.5);
      
      if (isPlaying) {
        gradient.addColorStop(0, 'rgba(56, 189, 248, 0.9)'); // Sky blue core
        gradient.addColorStop(0.5, 'rgba(56, 189, 248, 0.4)');
        gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
      } else {
        gradient.addColorStop(0, 'rgba(148, 163, 184, 0.5)'); // Slate dormant
        gradient.addColorStop(1, 'rgba(148, 163, 184, 0)');
      }

      ctx.beginPath();
      ctx.arc(centerX, centerY, dynamicRadius * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Draw rings if active
      if (isPlaying) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
        ctx.lineWidth = 2;
        
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          const ringRadius = baseRadius + (Math.sin(phase + i) * 10) + (volume * 20);
          ctx.arc(centerX, centerY, ringRadius + (i * 15), 0, Math.PI * 2);
          ctx.stroke();
        }
        phase += 0.05;
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, volume]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={400} 
      className="w-full max-w-[400px] h-auto aspect-square mx-auto"
    />
  );
};