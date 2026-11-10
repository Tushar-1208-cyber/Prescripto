import React, { useState, useEffect, useRef, useContext } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { AppContext } from '../context/AppContext';

const VideoConsultationModal = ({ appointment, onClose }) => {
    const { backendUrl, token } = useContext(AppContext);

    const [sessionToken, setSessionToken] = useState(null);
    const [callStatus, setCallStatus] = useState('initializing'); // initializing, waiting, connected, disconnected, error
    const [statusMessage, setStatusMessage] = useState('Initializing secure consultation session...');
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [permissionError, setPermissionError] = useState(null);

    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const peerConnectionRef = useRef(null);
    const localStreamRef = useRef(null);
    const socketRef = useRef(null);
    const pendingCandidatesRef = useRef([]);
    const sessionTokenRef = useRef(null);

    useEffect(() => {
        let isMounted = true;

        const initializeConsultation = async () => {
            try {
                // Step 1: Request authenticated consultation session token from backend
                setStatusMessage('Authenticating consultation appointment...');
                const { data } = await axios.post(
                    `${backendUrl}/api/video/patient-token`,
                    { appointmentId: appointment._id },
                    { headers: { token } }
                );

                if (!data.success) {
                    setCallStatus('error');
                    setStatusMessage(data.message || 'Failed to authenticate video session');
                    return;
                }

                if (!isMounted) return;
                setSessionToken(data.sessionToken);
                sessionTokenRef.current = data.sessionToken;

                // Step 2: Request Camera & Microphone access
                setStatusMessage('Requesting camera & microphone access...');
                let localStream;
                try {
                    localStream = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                        audio: true
                    });
                } catch (mediaErr) {
                    console.error('Media permission error:', mediaErr);
                    setPermissionError('Camera/Microphone access was denied. Please allow permissions in your browser to proceed.');
                    setCallStatus('error');
                    return;
                }

                if (!isMounted) {
                    localStream.getTracks().forEach(t => t.stop());
                    return;
                }

                localStreamRef.current = localStream;
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = localStream;
                }

                // Step 3: Initialize RTCPeerConnection with backend ICE servers
                const iceServers = data.iceServers && data.iceServers.length > 0
                    ? data.iceServers
                    : [{ urls: 'stun:stun.l.google.com:19302' }];

                const pc = new RTCPeerConnection({ iceServers });
                peerConnectionRef.current = pc;

                // Attach local audio/video tracks to peer connection
                localStream.getTracks().forEach((track) => {
                    pc.addTrack(track, localStream);
                });

                // Listen for remote tracks
                pc.ontrack = (event) => {
                    if (event.streams && event.streams[0]) {
                        if (remoteVideoRef.current) {
                            remoteVideoRef.current.srcObject = event.streams[0];
                        }
                        setCallStatus('connected');
                        setStatusMessage('Consultation in Progress');
                    }
                };

                // Listen for local ICE candidates
                pc.onicecandidate = (event) => {
                    if (event.candidate && socketRef.current) {
                        socketRef.current.emit('new_ice_candidate', {
                            appointmentId: appointment._id,
                            sessionToken: data.sessionToken,
                            candidate: event.candidate
                        });
                    }
                };

                pc.oniceconnectionstatechange = () => {
                    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                        setCallStatus('connected');
                        setStatusMessage('Consultation in Progress');
                    } else if (pc.iceConnectionState === 'disconnected') {
                        setStatusMessage('Connection interrupted, attempting to reconnect...');
                    } else if (pc.iceConnectionState === 'failed') {
                        setCallStatus('error');
                        setStatusMessage('Connection failed. Please check your internet connection.');
                    }
                };

                // Step 4: Connect Socket.io signaling
                const socket = io(backendUrl);
                socketRef.current = socket;

                socket.emit('join_video_room', {
                    appointmentId: appointment._id,
                    sessionToken: data.sessionToken
                });

                socket.on('video_room_joined', (roomData) => {
                    if (roomData.participantsCount === 1) {
                        setCallStatus('waiting');
                        setStatusMessage(`Waiting for Dr. ${appointment.docData?.name || 'Doctor'} to join...`);
                    }
                });

                socket.on('video_room_error', (errData) => {
                    setCallStatus('error');
                    setStatusMessage(errData.message || 'Consultation room error');
                });

                socket.on('peer_joined', async () => {
                    setStatusMessage(`Dr. ${appointment.docData?.name || 'Doctor'} has joined. Connecting...`);
                });

                // When both peers are present, Patient initiates the SDP Offer
                socket.on('both_peers_ready', async () => {
                    try {
                        setStatusMessage('Negotiating peer connection...');
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);

                        socket.emit('video_offer', {
                            appointmentId: appointment._id,
                            sessionToken: data.sessionToken,
                            sdp: pc.localDescription
                        });
                    } catch (offerErr) {
                        console.error('Error creating SDP offer:', offerErr);
                    }
                });

                socket.on('video_offer', async ({ sdp }) => {
                    try {
                        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);

                        socket.emit('video_answer', {
                            appointmentId: appointment._id,
                            sessionToken: data.sessionToken,
                            sdp: pc.localDescription
                        });

                        // Flush any queued candidates
                        while (pendingCandidatesRef.current.length > 0) {
                            const c = pendingCandidatesRef.current.shift();
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                        }
                    } catch (ansErr) {
                        console.error('Error handling video offer:', ansErr);
                    }
                });

                socket.on('video_answer', async ({ sdp }) => {
                    try {
                        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                        // Flush any queued candidates
                        while (pendingCandidatesRef.current.length > 0) {
                            const c = pendingCandidatesRef.current.shift();
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                        }
                    } catch (err) {
                        console.error('Error setting remote description:', err);
                    }
                });

                socket.on('new_ice_candidate', async ({ candidate }) => {
                    try {
                        if (pc.remoteDescription && pc.remoteDescription.type) {
                            await pc.addIceCandidate(new RTCIceCandidate(candidate));
                        } else {
                            pendingCandidatesRef.current.push(candidate);
                        }
                    } catch (iceErr) {
                        console.error('Error adding ICE candidate:', iceErr);
                    }
                });

                socket.on('peer_left', ({ message }) => {
                    setCallStatus('disconnected');
                    setStatusMessage(message || 'The doctor has ended or left the call.');
                });

            } catch (err) {
                console.error('Error initializing video consultation:', err);
                setCallStatus('error');
                setStatusMessage(err.response?.data?.message || err.message || 'Error joining consultation');
            }
        };

        initializeConsultation();

        // Teardown & cleanup on unmount
        return () => {
            isMounted = false;

            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => {
                    track.stop();
                });
            }

            if (socketRef.current) {
                socketRef.current.emit('leave_video_call', {
                    appointmentId: appointment._id,
                    sessionToken: sessionTokenRef.current || sessionToken
                });
                socketRef.current.disconnect();
            }

            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
        };
    }, [appointment._id, backendUrl, token]);

    // Control: Toggle Microphone
    const toggleMicrophone = () => {
        if (localStreamRef.current) {
            const audioTracks = localStreamRef.current.getAudioTracks();
            if (audioTracks.length > 0) {
                const nextState = !audioTracks[0].enabled;
                audioTracks[0].enabled = nextState;
                setIsMuted(!nextState);
            }
        }
    };

    // Control: Toggle Camera
    const toggleCamera = () => {
        if (localStreamRef.current) {
            const videoTracks = localStreamRef.current.getVideoTracks();
            if (videoTracks.length > 0) {
                const nextState = !videoTracks[0].enabled;
                videoTracks[0].enabled = nextState;
                setIsVideoOff(!nextState);
            }
        }
    };

    // Control: End Consultation
    const handleEndCall = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
        }
        if (socketRef.current) {
            socketRef.current.emit('leave_video_call', {
                appointmentId: appointment._id,
                sessionToken: sessionTokenRef.current || sessionToken
            });
            socketRef.current.disconnect();
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
            <div className="relative w-full max-w-4xl h-[85vh] bg-gray-900 rounded-2xl overflow-hidden shadow-2xl flex flex-col border border-gray-800">
                {/* Header */}
                <div className="bg-gray-950/80 px-4 py-3 flex items-center justify-between border-b border-gray-800 z-10">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary font-bold">
                            Dr
                        </div>
                        <div>
                            <h3 className="text-white font-semibold text-sm sm:text-base">
                                Dr. {appointment.docData?.name || 'Doctor'}
                            </h3>
                            <p className="text-gray-400 text-xs">
                                {appointment.docData?.speciality} &bull; Appointment #{appointment._id.slice(-6)}
                            </p>
                        </div>
                    </div>

                    {/* Status Pill */}
                    <div className="flex items-center gap-2">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                            callStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                            callStatus === 'waiting' ? 'bg-amber-500 animate-ping' :
                            callStatus === 'error' ? 'bg-rose-500' : 'bg-blue-500'
                        }`} />
                        <span className="text-xs text-gray-300 hidden sm:inline">{statusMessage}</span>
                    </div>
                </div>

                {/* Main Video Stage */}
                <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
                    {/* Remote Doctor Video Feed */}
                    <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        className={`w-full h-full object-cover transition-opacity duration-300 ${
                            callStatus === 'connected' ? 'opacity-100' : 'opacity-0'
                        }`}
                    />

                    {/* Waiting / Connecting / Disconnected Placeholder */}
                    {callStatus !== 'connected' && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-gradient-to-b from-gray-900 to-black">
                            <div className="w-20 h-20 rounded-full bg-gray-800 border-2 border-primary/50 flex items-center justify-center text-3xl mb-4 shadow-lg">
                                {callStatus === 'disconnected' ? '👋' : '👨‍⚕️'}
                            </div>
                            <h4 className="text-white font-medium text-lg mb-2">
                                {callStatus === 'waiting' ? `Waiting for Dr. ${appointment.docData?.name || 'Doctor'} to join` :
                                 callStatus === 'disconnected' ? 'Consultation Ended' :
                                 callStatus === 'error' ? 'Unable to Connect' : 'Connecting Consultation'}
                            </h4>
                            <p className="text-gray-400 text-sm max-w-md">
                                {permissionError || statusMessage}
                            </p>
                            {callStatus === 'waiting' && (
                                <div className="mt-4 flex items-center gap-2 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/60 px-3 py-1.5 rounded-full">
                                    <span className="animate-spin inline-block w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full" />
                                    The doctor will appear here as soon as they enter the consultation.
                                </div>
                            )}
                            {callStatus === 'disconnected' && (
                                <button
                                    onClick={onClose}
                                    className="mt-4 px-6 py-2 rounded-full bg-primary hover:bg-primary/90 text-white font-medium text-sm transition-all"
                                >
                                    Close Window
                                </button>
                            )}
                        </div>
                    )}

                    {/* PiP Local Video Thumbnail (Patient) */}
                    <div className="absolute bottom-4 right-4 w-28 sm:w-44 h-36 sm:h-56 bg-gray-900 rounded-xl overflow-hidden shadow-2xl border-2 border-gray-700 z-20">
                        <video
                            ref={localVideoRef}
                            autoPlay
                            playsInline
                            muted
                            className={`w-full h-full object-cover transform -scale-x-100 ${
                                isVideoOff ? 'opacity-0' : 'opacity-100'
                            }`}
                        />
                        {isVideoOff && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-800 text-gray-400 text-xs">
                                <span>📷 Off</span>
                            </div>
                        )}
                        <span className="absolute bottom-1 left-2 text-[10px] text-white/80 bg-black/50 px-1.5 py-0.5 rounded">
                            You {isMuted ? '(Muted)' : ''}
                        </span>
                    </div>
                </div>

                {/* Bottom Control Bar */}
                <div className="bg-gray-950/90 border-t border-gray-800 px-6 py-4 flex items-center justify-center gap-4 z-10">
                    {/* Mic Toggle */}
                    <button
                        onClick={toggleMicrophone}
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                            isMuted ? 'bg-rose-600 hover:bg-rose-700 text-white' : 'bg-gray-800 hover:bg-gray-700 text-white'
                        }`}
                        title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
                    >
                        {isMuted ? '🔇' : '🎙️'}
                    </button>

                    {/* Camera Toggle */}
                    <button
                        onClick={toggleCamera}
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                            isVideoOff ? 'bg-rose-600 hover:bg-rose-700 text-white' : 'bg-gray-800 hover:bg-gray-700 text-white'
                        }`}
                        title={isVideoOff ? 'Turn Camera On' : 'Turn Camera Off'}
                    >
                        {isVideoOff ? '🚫' : '📹'}
                    </button>

                    {/* End Call Button */}
                    <button
                        onClick={handleEndCall}
                        className="px-6 h-12 rounded-full bg-rose-600 hover:bg-rose-700 text-white font-medium text-sm flex items-center gap-2 shadow-lg shadow-rose-600/30 transition-all"
                    >
                        <span>📞</span> End Call
                    </button>
                </div>
            </div>
        </div>
    );
};

export default VideoConsultationModal;
