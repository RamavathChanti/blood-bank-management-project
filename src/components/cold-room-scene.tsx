"use client";
import { Canvas } from "@react-three/fiber";
import { Component as Boundary, type ReactNode } from "react";
import { COMPONENTS, type Unit } from "@/core/domain";
class SceneBoundary extends Boundary<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>3D is unavailable. Use the inventory list below.</p> : this.props.children; }
}
export default function ColdRoomScene({ units, selected, onSelect }: { units: readonly Unit[]; selected: string; onSelect: (id: string) => void }) {
  return <SceneBoundary><Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [6, 5, 10], fov: 45 }} fallback={<p>WebGL unavailable. The same inventory is listed below.</p>} aria-label="Three storage chambers; select units using the list below">
    <color attach="background" args={["#101923"]} /><ambientLight intensity={1.3} /><directionalLight position={[3, 8, 5]} intensity={3} />
    <group rotation={[0, -.3, 0]}>{COMPONENTS.map((component, chamber) => <group key={component} position={[(chamber - 1) * 3.1, 0, 0]}>
      <mesh position={[0, -.15, 0]}><boxGeometry args={[2.7, .15, 2]} /><meshStandardMaterial color="#4c667a" /></mesh>
      {[0, 1, 2].map(level => <mesh key={level} position={[0, level * 1.1, -.8]}><boxGeometry args={[2.7, .06, .3]} /><meshStandardMaterial color="#7994a8" /></mesh>)}
      <mesh position={[-1.4, 1, -.8]}><boxGeometry args={[.07, 2.4, .07]} /><meshStandardMaterial color="#7994a8" /></mesh>
      <mesh position={[1.4, 1, -.8]}><boxGeometry args={[.07, 2.4, .07]} /><meshStandardMaterial color="#7994a8" /></mesh>
      {units.filter(u => u.component === component).slice(0, 18).map((unit, index) => <mesh key={unit.id} position={[(index % 6 - 2.5) * .42, Math.floor(index / 6) * 1.1 + .4, 0]} onClick={event => { event.stopPropagation(); onSelect(unit.id); }} scale={unit.id === selected ? 1.16 : 1}>
        <boxGeometry args={[.32, .65, .2]} /><meshStandardMaterial color={unit.status === "QUARANTINED" ? "#e2ac54" : component === "PRBC" ? "#c94466" : component === "PLATELETS" ? "#ead279" : "#75ccbd"} emissive={unit.id === selected ? "#335577" : "#000000"} wireframe={unit.status === "EXPIRED"} />
      </mesh>)}
    </group>)}</group>
  </Canvas></SceneBoundary>;
}
