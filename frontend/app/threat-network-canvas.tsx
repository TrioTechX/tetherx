"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { motion } from "framer-motion";

type SeverityLevel = "CLEAR" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface ThreatNetworkNode {
    id: string;
    label: string;
    threat_level: SeverityLevel;
    match_count: number;
    message_count: number;
    position: { x: number; y: number; z: number };
}

interface ThreatNetworkEdge {
    source: string;
    target: string;
    weight: number;
    threat_count: number;
    severity: SeverityLevel;
}

interface ThreatNetworkData {
    nodes: ThreatNetworkNode[];
    edges: ThreatNetworkEdge[];
    total_nodes: number;
    total_edges: number;
    network_threat_level: SeverityLevel;
    timestamp: string;
}

const SEVERITY_COLORS: Record<SeverityLevel, number> = {
    CLEAR: 0x00d9ff,
    LOW: 0x4ade80,
    MEDIUM: 0xfbbf24,
    HIGH: 0xff6e40,
    CRITICAL: 0xff1744,
};

function disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
            child.geometry.dispose();
            const material = child.material;
            if (Array.isArray(material)) {
                material.forEach((m) => m.dispose());
            } else {
                material.dispose();
            }
        }
    });
}

export function ThreatNetworkCanvasRenderer({
    data,
    selectedNode,
    onSelectNode,
    autoRotate = false,
}: {
    data: ThreatNetworkData | null;
    selectedNode: string | null;
    onSelectNode: (id: string) => void;
    autoRotate?: boolean;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const graphGroupRef = useRef<THREE.Group | null>(null);
    const nodeMeshesRef = useRef<THREE.Object3D[]>([]);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const animationFrameRef = useRef<number | null>(null);
    const onSelectNodeRef = useRef(onSelectNode);
    const autoRotateRef = useRef(autoRotate);
    const isDraggingRef = useRef(false);
    const previousPointerRef = useRef({ x: 0, y: 0 });

    const [zoomLevel, setZoomLevel] = useState(80);
    const minZoom = 20;
    const maxZoom = 200;

    useEffect(() => {
        onSelectNodeRef.current = onSelectNode;
    }, [onSelectNode]);

    useEffect(() => {
        autoRotateRef.current = autoRotate;
    }, [autoRotate]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0e27);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
        camera.position.set(0, 0, 80);  // Moved camera closer for better visibility
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        // Enhanced lighting for better node visibility
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        const pointLight1 = new THREE.PointLight(0xffffff, 1.2);
        pointLight1.position.set(30, 30, 30);
        const pointLight2 = new THREE.PointLight(0x6699ff, 0.5);
        pointLight2.position.set(-30, -30, 30);
        scene.add(ambientLight);
        scene.add(pointLight1);
        scene.add(pointLight2);

        const graphGroup = new THREE.Group();
        graphGroupRef.current = graphGroup;
        scene.add(graphGroup);

        // Add reference grid for spatial awareness
        const gridHelper = new THREE.GridHelper(60, 20, 0x00ffff, 0x1a3355);
        gridHelper.position.y = -10;
        gridHelper.material.transparent = true;
        gridHelper.material.opacity = 0.15;
        scene.add(gridHelper);

        const resize = () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            if (width <= 0 || height <= 0) return;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
        };

        const handlePointerDown = (event: PointerEvent) => {
            const canvasRect = renderer.domElement.getBoundingClientRect();
            if (!canvasRect.width || !canvasRect.height) return;

            pointerRef.current.x = ((event.clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
            pointerRef.current.y = -((event.clientY - canvasRect.top) / canvasRect.height) * 2 + 1;

            raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current!);
            const intersects = raycasterRef.current.intersectObjects(nodeMeshesRef.current, true);
            
            if (intersects.length > 0) {
                const nodeId = intersects[0]?.object?.userData?.nodeId as string | undefined;
                if (nodeId) {
                    onSelectNodeRef.current(nodeId);
                    return;
                }
            }

            // Start drag for rotation
            isDraggingRef.current = true;
            previousPointerRef.current = { x: event.clientX, y: event.clientY };
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (!isDraggingRef.current || !graphGroupRef.current) return;

            const deltaX = event.clientX - previousPointerRef.current.x;
            const deltaY = event.clientY - previousPointerRef.current.y;

            graphGroupRef.current.rotation.y += deltaX * 0.005;
            graphGroupRef.current.rotation.x += deltaY * 0.005;

            previousPointerRef.current = { x: event.clientX, y: event.clientY };
        };

        const handlePointerUp = () => {
            isDraggingRef.current = false;
        };

        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            const delta = event.deltaY * -0.05;
            const newZoom = Math.max(minZoom, Math.min(maxZoom, camera.position.z - delta));
            camera.position.z = newZoom;
            setZoomLevel(newZoom);
        };

        const animate = () => {
            animationFrameRef.current = window.requestAnimationFrame(animate);
            if (autoRotateRef.current && graphGroupRef.current) {
                graphGroupRef.current.rotation.y += 0.003;  // Slightly faster rotation
                graphGroupRef.current.rotation.x += 0.001;  // Add subtle X rotation
            }
            renderer.render(scene, camera);
        };

        resize();
        window.addEventListener("resize", resize);
        renderer.domElement.addEventListener("pointerdown", handlePointerDown);
        renderer.domElement.addEventListener("pointermove", handlePointerMove);
        renderer.domElement.addEventListener("pointerup", handlePointerUp);
        renderer.domElement.addEventListener("pointerleave", handlePointerUp);
        renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
        animate();

        return () => {
            if (animationFrameRef.current !== null) {
                window.cancelAnimationFrame(animationFrameRef.current);
            }
            window.removeEventListener("resize", resize);
            renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
            renderer.domElement.removeEventListener("pointermove", handlePointerMove);
            renderer.domElement.removeEventListener("pointerup", handlePointerUp);
            renderer.domElement.removeEventListener("pointerleave", handlePointerUp);
            renderer.domElement.removeEventListener("wheel", handleWheel);

            if (graphGroupRef.current) {
                disposeObject(graphGroupRef.current);
                scene.remove(graphGroupRef.current);
            }
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }

            nodeMeshesRef.current = [];
            graphGroupRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
        };
    }, []);

    useEffect(() => {
        const group = graphGroupRef.current;
        if (!group) return;

        group.children.forEach((child) => {
            disposeObject(child);
            group.remove(child);
        });
        nodeMeshesRef.current = [];

        if (!data) return;

        const nodePositionMap = new Map(
            data.nodes.map((node) => [
                node.id,
                new THREE.Vector3(node.position.x, node.position.y, node.position.z),
            ])
        );

        data.edges.forEach((edge) => {
            const source = nodePositionMap.get(edge.source);
            const target = nodePositionMap.get(edge.target);
            if (!source || !target) return;

            const edgeGeometry = new THREE.BufferGeometry().setFromPoints([source, target]);
            const edgeMaterial = new THREE.LineBasicMaterial({
                color: SEVERITY_COLORS[edge.severity],
                transparent: true,
                opacity: Math.min(0.75, 0.25 + edge.weight / 15),
                linewidth: 2,  // Thicker lines for visibility
            });

            group.add(new THREE.Line(edgeGeometry, edgeMaterial));
        });

        // Calculate max message count for scaling
        const maxMessages = Math.max(...data.nodes.map(n => n.message_count), 1);

        data.nodes.forEach((node) => {
            const isSelected = selectedNode === node.id;
            
            // Dynamic radius based on message count and threat level
            const baseRadius = 2.5;  // Increased from 0.95 to 2.5 (2.6x larger)
            const sizeScale = 1 + (node.message_count / maxMessages) * 0.8;  // Scale by activity
            const selectedScale = isSelected ? 1.4 : 1.0;
            const radius = baseRadius * sizeScale * selectedScale;
            
            // More detailed geometry for better appearance
            const nodeGeometry = new THREE.SphereGeometry(radius, 32, 32);
            
            // Enhanced material with glow effect
            const nodeMaterial = new THREE.MeshStandardMaterial({
                color: SEVERITY_COLORS[node.threat_level],
                emissive: SEVERITY_COLORS[node.threat_level],
                emissiveIntensity: isSelected ? 0.5 : 0.25,  // Strong glow
                metalness: 0.3,
                roughness: 0.4,
            });

            const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial);
            mesh.position.set(node.position.x, node.position.y, node.position.z);
            mesh.userData.nodeId = node.id;
            
            // Add outer glow ring for critical threats
            if (node.threat_level === "CRITICAL" || node.threat_level === "HIGH") {
                const ringGeometry = new THREE.RingGeometry(radius * 1.2, radius * 1.4, 32);
                const ringMaterial = new THREE.MeshBasicMaterial({
                    color: SEVERITY_COLORS[node.threat_level],
                    transparent: true,
                    opacity: 0.6,
                    side: THREE.DoubleSide,
                });
                const ring = new THREE.Mesh(ringGeometry, ringMaterial);
                ring.position.copy(mesh.position);
                ring.lookAt(0, 0, 0);  // Face the camera
                group.add(ring);
            }
            
            group.add(mesh);
            nodeMeshesRef.current.push(mesh);
        });
    }, [data, selectedNode]);

    const handleZoomIn = () => {
        if (!cameraRef.current) return;
        const newZoom = Math.max(minZoom, cameraRef.current.position.z - 10);
        cameraRef.current.position.z = newZoom;
        setZoomLevel(newZoom);
    };

    const handleZoomOut = () => {
        if (!cameraRef.current) return;
        const newZoom = Math.min(maxZoom, cameraRef.current.position.z + 10);
        cameraRef.current.position.z = newZoom;
        setZoomLevel(newZoom);
    };

    const handleResetView = () => {
        if (!cameraRef.current || !graphGroupRef.current) return;
        cameraRef.current.position.set(0, 0, 80);
        graphGroupRef.current.rotation.set(0, 0, 0);
        setZoomLevel(80);
    };

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full" />
            
            {/* Zoom Controls */}
            <div className="absolute bottom-4 right-4 flex flex-col gap-2">
                <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleZoomIn}
                    className="bg-slate-900/80 backdrop-blur-sm border border-sentinel-cyan/30 hover:border-sentinel-cyan/60 rounded-lg p-2 text-sentinel-cyan transition-all"
                    title="Zoom In"
                >
                    <ZoomIn size={20} />
                </motion.button>
                
                <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleZoomOut}
                    className="bg-slate-900/80 backdrop-blur-sm border border-sentinel-cyan/30 hover:border-sentinel-cyan/60 rounded-lg p-2 text-sentinel-cyan transition-all"
                    title="Zoom Out"
                >
                    <ZoomOut size={20} />
                </motion.button>
                
                <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleResetView}
                    className="bg-slate-900/80 backdrop-blur-sm border border-sentinel-green/30 hover:border-sentinel-green/60 rounded-lg p-2 text-sentinel-green transition-all"
                    title="Reset View"
                >
                    <Maximize2 size={20} />
                </motion.button>
            </div>

            {/* Zoom Level Indicator */}
            <div className="absolute bottom-4 left-4 bg-slate-900/80 backdrop-blur-sm border border-sentinel-cyan/30 rounded-lg px-3 py-2 text-xs text-sentinel-cyan font-mono">
                Zoom: {Math.round((maxZoom - zoomLevel) / (maxZoom - minZoom) * 100)}%
            </div>

            {/* Interaction Hint */}
            <div className="absolute top-4 left-4 bg-slate-900/80 backdrop-blur-sm border border-slate-600/30 rounded-lg px-3 py-2 text-xs text-slate-400 space-y-1">
                <div>🖱️ <span className="text-slate-300">Scroll</span> to zoom</div>
                <div>🖱️ <span className="text-slate-300">Drag</span> to rotate</div>
                <div>🖱️ <span className="text-slate-300">Click node</span> for details</div>
            </div>
        </div>
    );
}
