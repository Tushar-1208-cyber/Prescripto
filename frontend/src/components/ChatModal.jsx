import React, { useState, useEffect, useRef, useContext } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { AppContext } from '../context/AppContext';

let socket;

const ChatModal = ({ appointment, onClose, currentUserRole = 'user' }) => {
    const { backendUrl, userData, token } = useContext(AppContext);
    const [messages, setMessages] = useState([]);
    const [text, setText] = useState('');
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        // Connect socket with JWT auth
        socket = io(backendUrl, {
            auth: { token }
        });

        socket.emit('join_room', { appointmentId: appointment._id, token });

        // Fetch past messages history with token header
        const fetchHistory = async () => {
            try {
                const { data } = await axios.get(`${backendUrl}/api/chat/messages/${appointment._id}`, {
                    headers: { token }
                });
                if (data.success) {
                    setMessages(data.messages);
                }
            } catch (err) {
                console.error('Error fetching chat history:', err.message);
            }
        };

        fetchHistory();

        // Listen for new messages
        socket.on('receive_message', (newMsg) => {
            setMessages((prev) => [...prev, newMsg]);
        });

        socket.on('chat_error', (err) => {
            console.error('Chat error event:', err.message);
        });

        return () => {
            socket.emit('leave_room', { appointmentId: appointment._id });
            socket.disconnect();
        };
    }, [appointment._id, backendUrl, token]);

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSendMessage = (e) => {
        e.preventDefault();
        if (!text.trim()) return;

        const senderId = currentUserRole === 'user' ? appointment.userId : appointment.docId;
        const senderName = currentUserRole === 'user' ? (userData?.name || 'Patient') : `Dr. ${appointment.docData?.name || 'Doctor'}`;

        const msgData = {
            appointmentId: appointment._id,
            token,
            senderId,
            senderName,
            senderRole: currentUserRole,
            message: text.trim()
        };

        socket.emit('send_message', msgData);
        setText('');
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg h-[550px] flex flex-col overflow-hidden border">
                {/* Header */}
                <div className="bg-primary text-white p-4 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <img 
                            src={currentUserRole === 'user' ? appointment.docData?.image : appointment.userData?.image} 
                            alt="" 
                            className="w-10 h-10 rounded-full object-cover bg-white/20 border border-white"
                        />
                        <div>
                            <p className="font-semibold text-sm">
                                {currentUserRole === 'user' ? `Dr. ${appointment.docData?.name}` : appointment.userData?.name}
                            </p>
                            <p className="text-xs text-white/80 flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse"></span>
                                Live Consultation Chat
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-white/80 hover:text-white text-2xl font-bold">&times;</button>
                </div>

                {/* Messages Body */}
                <div className="flex-1 p-4 overflow-y-auto bg-gray-50 flex flex-col gap-3">
                    {messages.length === 0 ? (
                        <div className="text-center text-gray-400 text-xs my-auto">
                            <p className="text-2xl mb-1">💬</p>
                            <p>No messages yet.</p>
                            <p>Start the consultation conversation below.</p>
                        </div>
                    ) : (
                        messages.map((msg, idx) => {
                            const isMe = msg.senderRole === currentUserRole;
                            return (
                                <div key={idx} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                                    <span className="text-[10px] text-gray-400 mb-0.5 px-1">{msg.senderName}</span>
                                    <div className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-xs ${
                                        isMe 
                                            ? 'bg-primary text-white rounded-br-xs shadow-sm' 
                                            : 'bg-white text-gray-800 border rounded-bl-xs shadow-xs'
                                    }`}>
                                        <p className="leading-relaxed">{msg.message}</p>
                                    </div>
                                    <span className="text-[9px] text-gray-400 mt-0.5 px-1">
                                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            );
                        })
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Footer Input */}
                <form onSubmit={handleSendMessage} className="p-3 bg-white border-t flex gap-2 items-center">
                    <input
                        type="text"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Type your message here..."
                        className="flex-1 border rounded-full px-4 py-2 text-xs outline-none focus:border-primary"
                    />
                    <button
                        type="submit"
                        className="bg-primary text-white px-5 py-2 rounded-full text-xs font-semibold hover:opacity-90 transition-all">
                        Send
                    </button>
                </form>
            </div>
        </div>
    );
};

export default ChatModal;
